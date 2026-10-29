import { describe, expect } from "bun:test"
import path from "path"
import { Clock, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { Tool } from "@opencode/core/tool"
import { ToolOutput } from "@opencode/core/tool-output"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { Workspace } from "@opencode/core/workspace"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const workspaceLocation = Layer.effect(
  Location.Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    return Location.Service.of({ ...location, workspaceID: Workspace.ID.make("wrk_file_context") })
  }),
).pipe(Layer.provide(tempLocationLayer))

const memoryEnvironment = Layer.sync(Environment.Service, () => {
  const driver = Environment.makeMemoryDriver()
  return Environment.Service.of({ files: Environment.makeFiles(driver), spawner: driver.spawner })
})

const readToolNode = makeLocationNode({
  name: "test/s3-read-context",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [Tool.node, ReadToolFileSystem.node, FileAccess.node, SessionInstructions.node, FSUtil.node, Location.node],
})

const config = Config.testLayer()
const layer = AppNodeBuilder.build(
  LayerNode.group([
    readToolNode,
    Session.node,
    SessionProjector.node,
    SessionStore.node,
    ToolOutput.node,
    Environment.node,
    Global.node,
    Database.node,
    Location.node,
    FSUtil.node,
    Tool.node,
    SessionInstructions.node,
  ]),
  [
    Location.node.replace(workspaceLocation),
    Environment.node.replace(memoryEnvironment),
    Project.node.replace(globalProjectNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
    Config.node.replace(config),
    Image.node.replace(AppNodeBuilder.build(Image.node, [Config.node.replace(config)])),
  ],
)
const it = testEffect(layer)

const read = (registry: Tool.Interface, sessionID: Session.ID, file: string) =>
  executeTool(registry, {
    ...toolIdentity,
    sessionID,
    call: { type: "tool-call", id: crypto.randomUUID(), name: "read", input: { path: file } },
  })

describe("workspace auxiliary file context", () => {
  it.live("discovers and loads only workspace instructions and suggestions despite conflicting host files", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const environment = yield* Environment.Service
      const fs = yield* FSUtil.Service
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const registry = yield* Tool.Service
      const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      const sessionID = (yield* sessions.create({ location: ref })).id
      const nested = path.join(location.directory, "nested")
      const agents = path.join(nested, "AGENTS.md")
      yield* fs.ensureDir(nested)
      yield* fs.writeFileString(agents, "HOST instruction must not leak")
      yield* fs.writeFileString(path.join(nested, "host-only.txt"), "host")
      yield* environment.files.write(agents, new TextEncoder().encode("WORKSPACE instructions"))
      yield* environment.files.write(path.join(nested, "remote-only.txt"), new TextEncoder().encode("remote"))
      yield* environment.files.write(
        path.join(location.directory, "AGENTS.md"),
        new TextEncoder().encode("ROOT excluded"),
      )

      expect((yield* read(registry, sessionID, "nested/remote-only.txt")).status).toBe("completed")
      const injected = (yield* store.context(sessionID)).filter((message) => message.type === "synthetic")
      expect(injected).toHaveLength(1)
      expect(injected[0]?.text).toBe(`Instructions from: ${agents}\nWORKSPACE instructions`)
      yield* read(registry, sessionID, "nested")
      expect((yield* store.context(sessionID)).filter((message) => message.type === "synthetic")).toHaveLength(1)

      const missing = yield* read(registry, sessionID, "nested/only.txt")
      expect(missing.status).toBe("error")
      expect(JSON.stringify(missing.error)).toContain("remote-only.txt")
      expect(JSON.stringify(missing.error)).not.toContain("host-only.txt")

      // A host-only instruction file is absent, not a fallback source.
      yield* environment.files.remove(agents)
      const other = (yield* sessions.create({ location: ref })).id
      const instructions = yield* SessionInstructions.Service
      yield* instructions.load({ sessionID: other, paths: [agents] })
      expect((yield* store.context(other)).filter((message) => message.type === "synthetic")).toHaveLength(0)
      const failure = yield* instructions
        .load({ sessionID: other, paths: [nested] })
        .pipe(Effect.catchDefect((defect) => Effect.succeed(defect)))
      expect(failure).toBeInstanceOf(Environment.WrongKind)
    }),
  )

  it.live("retains truncation and saved bytes in the workspace where the read tool can retrieve them", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const environment = yield* Environment.Service
      const output = yield* ToolOutput.Service
      const fs = yield* FSUtil.Service
      const registry = yield* Tool.Service
      const sessions = yield* Session.Service
      const global = yield* Global.Service
      const sessionID = (yield* sessions.create({
        location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
      })).id
      yield* output.transform((editor) => editor.configure({ maxLines: 1 }))
      const stale = path.join(location.project.directory, ".opencode", "tool-output", ToolOutput.fileName())
      yield* environment.files.write(stale, new TextEncoder().encode("expired"))
      const future = (yield* Clock.currentTimeMillis) + Duration.toMillis(ToolOutput.RETENTION) + 60_000
      const result = yield* Effect.gen(function* () {
        yield* TestClock.setTime(future)
        return yield* output.truncate({ content: [{ type: "text", text: "one\ntwo\nthree" }] })
      }).pipe(Effect.provide(TestClock.layer()))
      expect(yield* Environment.exists(environment.files, stale)).toBe(false)
      const file = result.metadata?.outputPath
      expect(typeof file).toBe("string")
      if (typeof file !== "string") throw new Error("Missing retained path")
      expect(file.startsWith(path.join(location.project.directory, ".opencode", "tool-output"))).toBe(true)
      expect(yield* fs.exists(file)).toBe(false)
      expect((yield* read(registry, sessionID, file)).content?.[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("3: three"),
      })
      const saved = yield* output.save(new Uint8Array([1, 2, 3]), ".bin")
      expect((yield* environment.files.read(saved)).bytes).toEqual(new Uint8Array([1, 2, 3]))
      expect(yield* fs.exists(saved)).toBe(false)

      const hostFile = path.join(global.data, "tool-output", path.basename(file))
      yield* fs.writeWithDirs(hostFile, "host sentinel")
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(future)
        yield* output.cleanup()
      }).pipe(Effect.provide(TestClock.layer()))
      expect(yield* Environment.exists(environment.files, file)).toBe(false)
      expect(yield* Environment.exists(environment.files, saved)).toBe(false)
      expect(yield* fs.readFileString(hostFile)).toBe("host sentinel")
    }),
  )
})
