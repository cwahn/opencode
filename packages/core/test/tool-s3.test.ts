import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Environment } from "@opencode/core/environment/index"
import { EnvironmentUnavailable } from "@opencode/core/environment/unavailable"
import { S3Files } from "@opencode/core/environment/s3"
import { Config } from "@opencode/core/config"
import { FileAccess } from "@opencode/core/file-access"
import { FileMutation } from "@opencode/core/file-mutation"
import { Formatter } from "@opencode/core/formatter"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { Tool } from "@opencode/core/tool"
import { ToolOutput } from "@opencode/core/tool-output"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import { GlobTool } from "@opencode/core/tool/plugin/glob"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { Ripgrep } from "@opencode/core/ripgrep"
import { RipgrepBinary } from "@opencode/core/ripgrep/binary"
import { S3Ripgrep } from "@opencode/core/ripgrep/s3"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { Workspace } from "@opencode/core/workspace"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { location } from "./fixture/location"
import { hasS3Fixture, s3Fixture } from "./fixture/s3"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { it } from "./lib/effect"

const tools = makeLocationNode({
  name: "test/s3-file-leaves",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      yield* registerToolPlugin(ReadTool.Plugin)
      yield* registerToolPlugin(WriteTool.Plugin)
      yield* registerToolPlugin(EditTool.Plugin)
      yield* registerToolPlugin(PatchTool.Plugin)
      yield* registerToolPlugin(GlobTool.Plugin)
      yield* registerToolPlugin(GrepTool.Plugin)
    }),
  ),
  deps: [
    Tool.node, ReadToolFileSystem.node, FileAccess.node, FileMutation.node,
    Environment.node, Formatter.node, Permission.node, Location.node, SessionInstructions.node, FSUtil.node, Ripgrep.node,
  ],
})

const verify = (options: S3Files.Options) => Effect.gen(function* () {
  const files = S3Files.make(options)
  const state: { deny: boolean; assertions: Permission.AssertInput[] } = { deny: false, assertions: [] }
  const permission = permissionLayer({
    assert: (input) => Effect.suspend(() => {
      state.assertions.push(input)
      return state.deny && input.action === "edit"
        ? Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }))
        : Effect.void
    }),
  })
  const layer = AppNodeBuilder.build(LayerNode.group([tools, Tool.node, ToolOutput.node]), [
    Environment.node.replace(Layer.succeed(Environment.Service, {
      files, spawner: EnvironmentUnavailable.spawner,
    })),
    Location.node.replace(Layer.succeed(Location.Service, location({
      directory: AbsolutePath.make("/workspace"),
      workspaceID: Workspace.ID.make(`wrk_${crypto.randomUUID()}`),
    }))),
    Formatter.node.replace(Layer.succeed(Formatter.Service, {
      file: () => Effect.succeed(false),
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    })),
    Permission.node.replace(permission),
    Config.node.replace(Config.testLayer()),
    Ripgrep.node.replace(makeLocationNode({
      service: Ripgrep.Service,
      layer: S3Ripgrep.layer(files),
      deps: [RipgrepBinary.node, CrossSpawnSpawner.node],
    })),
  ])
  yield* Effect.gen(function* () {
    const registry = yield* Tool.Service
    const output = yield* ToolOutput.Service
    const call = (name: string, input: Record<string, unknown>) => executeTool(registry, {
      ...toolIdentity,
      sessionID: Session.ID.make("ses_s3_file_leaves"),
      call: { type: "tool-call", id: crypto.randomUUID(), name, input },
    })
    const bytes = (name: string) => files.read(`/workspace/${name}`).pipe(
      Effect.map((result) => Buffer.from(result.bytes).toString("utf8")),
    )

    yield* files.write("/workspace/bom.txt", Buffer.from("\uFEFFbefore\n"))
    const read = yield* call("read", { path: "bom.txt" })
    expect(read.status).toBe("completed")
    expect(read.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("1: before") })
    expect(yield* bytes("bom.txt")).toBe("\uFEFFbefore\n")
    expect((yield* call("write", { path: "bom.txt", content: "written\n" })).status).toBe("completed")
    expect(yield* bytes("bom.txt")).toBe("\uFEFFwritten\n")
    expect((yield* call("edit", { path: "bom.txt", oldString: "written", newString: "edited" })).status).toBe("completed")
    expect(yield* bytes("bom.txt")).toBe("\uFEFFedited\n")

    yield* files.write("/workspace/delete.txt", Buffer.from("delete me\n"))
    const patched = yield* call("patch", { patchText: [
      "*** Begin Patch", "*** Add File: added.txt", "+new file",
      "*** Update File: bom.txt", "@@", "-edited", "+patched",
      "*** Delete File: delete.txt", "*** End Patch",
    ].join("\n") })
    expect(patched).toMatchObject({ status: "completed", output: { applied: [
      { type: "add", resource: "added.txt" },
      { type: "update", resource: "bom.txt" },
      { type: "delete", resource: "delete.txt" },
    ] } })
    expect(yield* bytes("added.txt")).toBe("new file\n")
    expect(yield* bytes("bom.txt")).toBe("\uFEFFpatched\n")
    expect(yield* Environment.exists(files, "/workspace/delete.txt")).toBe(false)
    expect(yield* call("glob", { pattern: "*.txt" })).toMatchObject({
      status: "completed", output: [
        { path: "added.txt", type: "file" },
        { path: "bom.txt", type: "file" },
      ],
    })
    expect(yield* call("grep", { pattern: "patched", include: "*.txt" })).toMatchObject({
      status: "completed", output: [{ entry: { path: "bom.txt" }, line: 1, text: "patched\n" }],
    })

    state.deny = true
    for (const [name, input] of [
      ["write", { path: "bom.txt", content: "forbidden" }],
      ["edit", { path: "bom.txt", oldString: "patched", newString: "forbidden" }],
      ["patch", { patchText: "*** Begin Patch\n*** Add File: forbidden.txt\n+forbidden\n*** End Patch" }],
    ] as const) {
      expect((yield* call(name, input)).status).toBe("error")
      expect(yield* bytes("bom.txt")).toBe("\uFEFFpatched\n")
      expect(yield* Environment.exists(files, "/workspace/forbidden.txt")).toBe(false)
    }
    expect(state.assertions.filter((input) => input.action === "edit").length).toBeGreaterThanOrEqual(6)
    state.deny = false

    // Preparation succeeds, then the real S3 adapter rejects a parent that is a file.
    yield* files.write("/workspace/blocker", Buffer.from("not a directory"))
    const partial = yield* call("patch", { patchText: [
      "*** Begin Patch", "*** Add File: committed.txt", "+committed before failure",
      "*** Add File: blocker/fails.txt", "+cannot write", "*** End Patch",
    ].join("\n") })
    expect(partial.status).toBe("error")
    expect(JSON.stringify(partial.error)).toContain("Completed before failure: committed.txt")
    expect(yield* bytes("committed.txt")).toBe("committed before failure\n")
    expect(yield* bytes("blocker")).toBe("not a directory")
    expect(yield* Environment.exists(files, "/workspace/blocker/fails.txt")).toBe(false)

    yield* output.transform((editor) => editor.configure({ maxLines: 1 }))
    const retained = yield* output.truncate({ content: [{ type: "text", text: "one\ntwo\nthree" }] })
    const target = retained.metadata?.outputPath
    if (typeof target !== "string") throw new Error("Missing retained S3 output path")
    expect(target.startsWith("/workspace/.opencode/tool-output/")).toBe(true)
    expect(Buffer.from((yield* files.read(target)).bytes).toString()).toBe("one\ntwo\nthree")
    const retrieved = yield* call("read", { path: target })
    expect(retrieved.status).toBe("completed")
    expect(retrieved.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("3: three") })
  }).pipe(Effect.provide(layer))
})

const live = hasS3Fixture() || process.env.OPENCODE_TEST_S3_ENDPOINT ? it.live : it.live.skip
live("model file leaves mutate and retrieve actual S3 objects without an execution plane", () =>
  Effect.gen(function* () {
    const minio = hasS3Fixture()
      ? yield* Effect.acquireDisposable(Effect.promise(s3Fixture))
      : undefined
    const options = {
      endpoint: minio?.endpoint ?? process.env.OPENCODE_TEST_S3_ENDPOINT ?? "",
      bucket: minio?.bucket ?? process.env.OPENCODE_TEST_S3_BUCKET ?? "",
      accessKeyId: minio?.accessKeyId ?? process.env.OPENCODE_TEST_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: minio?.secretAccessKey ?? process.env.OPENCODE_TEST_S3_SECRET_ACCESS_KEY ?? "",
      region: process.env.OPENCODE_TEST_S3_REGION ?? "us-east-1",
      prefix: `tool-integration-${crypto.randomUUID()}`,
    }
    yield* Effect.addFinalizer(() => S3Files.make(options).remove("/workspace").pipe(Effect.orDie))
    yield* verify(options)
  }),
  // MinIO process startup plus real network requests through four tool leaves and retained-output storage.
  60_000,
)
