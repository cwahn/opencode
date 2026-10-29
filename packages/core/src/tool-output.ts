export * as ToolOutput from "./tool-output.js"

import path from "path"
import type { Tool } from "./tool.js"
import { Clock, Context, Duration, Effect, Layer, Ref, Schedule } from "effect"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Identifier } from "@opencode/schema/identifier"
import { FileRetention } from "./file-retention.js"
import { State } from "./state.js"
import { Environment } from "./environment/index.js"
import { Location } from "./location.js"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024 // 50 KiB
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"

export const fileName = (timestamp?: number) => "tool_" + Identifier.create(false, timestamp)

type Result = Tool.NormalizedResult

type Limits = {
  maxLines: number
  maxBytes: number
}

export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly truncate: (result: Result) => Effect.Effect<Result>
  /** Writes bytes the model cannot receive inline to a retained file and returns its path. */
  readonly save: (bytes: Uint8Array, extension: string) => Effect.Effect<string>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const environment = yield* Environment.Service
    const directory = location.workspaceID
      ? path.join(location.project.directory, ".opencode", DIRECTORY)
      : path.join(global.data, DIRECTORY)
    const cleaned = yield* Ref.make(false)
    const cleanupWorkspace = Effect.fn("ToolOutput.cleanupWorkspace")(function* () {
      const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(RETENTION)
      const entries = yield* environment.files.list(directory).pipe(
        Effect.catchTag("Environment.NotFound", () => Effect.succeed([])),
        Effect.orDie,
      )
      yield* Effect.forEach(
        entries.filter((entry) => entry.type === "file" && /^tool_[0-9a-f]{12}/.test(entry.name)),
        (entry) =>
          Effect.gen(function* () {
            const file = path.join(directory, entry.name)
            const info = yield* environment.files.stat(file).pipe(
              Effect.catchTag("Environment.NotFound", () => Effect.succeed(undefined)),
              Effect.orDie,
            )
            if (!info || info.mtimeMs >= cutoff) return
            yield* environment.files.remove(file).pipe(Effect.orDie)
          }),
        { concurrency: 8, discard: true },
      )
    })
    const writeWorkspace = Effect.fnUntraced(function* (file: string, bytes: Uint8Array) {
      // Workspace retention is demand-driven; no background task wakes a remote workspace.
      if (!(yield* Ref.getAndSet(cleaned, true))) yield* cleanupWorkspace()
      yield* environment.files.mkdir(directory).pipe(Effect.orDie)
      yield* environment.files.write(file, bytes).pipe(Effect.orDie)
    })
    const state = State.create<Limits, Editor>({
      name: "tool-output",
      initial: () => ({ maxLines: MAX_LINES, maxBytes: MAX_BYTES }),
      editor: (editor) => ({
        configure: (limits) => {
          if (limits.maxLines !== undefined) editor.maxLines = limits.maxLines
          if (limits.maxBytes !== undefined) editor.maxBytes = limits.maxBytes
        },
      }),
    })

    const truncate = Effect.fnUntraced(function* (result: Result) {
      if (result.metadata?.truncated !== undefined) return result
      const content = result.content
      const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
      const limits = state.get()
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      const totalBytes = Buffer.byteLength(text, "utf-8")
      if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes)
        return { ...result, metadata: { ...result.metadata, truncated: false } }

      const kept: string[] = []
      let bytes = 0
      for (const line of lines.slice(0, limits.maxLines)) {
        const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
        if (bytes + size > limits.maxBytes) break
        kept.push(line)
        bytes += size
      }
      const file = path.join(directory, fileName())
      yield* location.workspaceID
        ? writeWorkspace(file, new TextEncoder().encode(text))
        : Effect.gen(function* () {
            yield* fs.ensureDir(directory).pipe(Effect.orDie)
            yield* fs.writeFileString(file, text).pipe(Effect.orDie)
          })
      const shown = kept.length > 0 ? `lines 1-${kept.length}` : "0 lines"
      const marker = `[showing ${shown} of ${lines.length}; full output saved to ${file}]`
      const bounded: Tool.Content[] = []
      let remaining = kept.join("\n").length
      let seenText = false
      let marked = false
      for (const item of content) {
        if (item.type === "file") {
          bounded.push(item)
          continue
        }
        if (seenText && remaining > 0) remaining--
        seenText = true
        if (remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }
        if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })
        if (!marked) bounded.push({ type: "text", text: marker })
        remaining = 0
        marked = true
      }
      if (!marked) bounded.push({ type: "text", text: marker })
      return {
        ...result,
        content: bounded,
        metadata: { ...result.metadata, truncated: true, outputPath: file },
      }
    })

    const save = Effect.fnUntraced(function* (bytes: Uint8Array, extension: string) {
      const file = path.join(directory, fileName() + extension)
      yield* location.workspaceID ? writeWorkspace(file, bytes) : fs.writeWithDirs(file, bytes).pipe(Effect.orDie)
      return file
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      save,
      cleanup: () => (location.workspaceID ? cleanupWorkspace() : cleanup(fs, directory)),
    })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode, Location.node, Environment.node],
})
