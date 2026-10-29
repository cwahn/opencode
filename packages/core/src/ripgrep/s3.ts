export * as S3Ripgrep from "./s3.js"

import path from "node:path"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Entry, Match } from "@opencode/schema/filesystem"
import { Glob } from "@opencode/util/glob"
import { collectStream, waitForAbort } from "@opencode/util/process"
import type { S3Files } from "../environment/s3.js"
import { Ripgrep } from "../ripgrep.js"
import { PositiveInt, NonNegativeInt, RelativePath } from "../schema.js"
import { RipgrepBinary } from "./binary.js"

const CHUNK_BYTES = 256 * 1024
const Record = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeMatch = Schema.decodeUnknownEffect(Record)
const failure = (cause: unknown) =>
  cause instanceof Ripgrep.Error || cause instanceof Ripgrep.InvalidPatternError
    ? cause
    : new Ripgrep.Error({ message: "S3 search failed", cause })

// Like rg globs, a pattern without slashes applies to basenames at any depth.
const matches = (pattern: string, value: string) =>
  Glob.match(pattern.replace(/^\//, ""), pattern.includes("/") ? value : path.posix.basename(value))

export const layer = (files: ReturnType<typeof S3Files.make>) =>
  Layer.effect(
    Ripgrep.Service,
    Effect.gen(function* () {
      const binary = yield* RipgrepBinary.Service
      const spawner = yield* ChildProcessSpawner
      const abortable = <A, E>(program: Effect.Effect<A, E>, signal?: AbortSignal) =>
        (signal ? program.pipe(Effect.raceFirst(waitForAbort(signal))) : program).pipe(Effect.mapError(failure))

      const candidates = Effect.fnUntraced(function* (cwd: string) {
        const root = path.posix.resolve(cwd)
        const objects = yield* files.walk(root)
        // S3 has no Git checkout. Apply repository-local ignore files from the object tree,
        // including nested files, but deliberately do not consult host/global Git configuration.
        const rules: { base: string; pattern: string; negate: boolean; directory: boolean }[] = []
        for (const object of objects.filter(
          (item) =>
            item.info.type === "file" &&
            !item.path.split("/").includes(".git") &&
            /\/(?:\.gitignore|\.ignore|\.rgignore)$/.test(item.path),
        )) {
          const content = yield* files.read(object.path)
          for (const line of new TextDecoder().decode(content.bytes).split(/\r?\n/)) {
            if (!line || line.startsWith("#")) continue
            rules.push({
              base: path.posix.dirname(object.path),
              pattern: line.replace(/^!/, "").replace(/\/$/, ""),
              negate: line.startsWith("!"),
              directory: line.endsWith("/"),
            })
          }
        }
        return objects
          .filter((object) => object.info.type === "file")
          .map((object) => {
            const relative = path.posix.relative(root, object.path)
            const ignored = rules.reduce((ignored, rule) => {
              const local = path.posix.relative(rule.base, object.path)
              if (local.startsWith("../")) return ignored
              const parts = local.split("/")
              const hit = parts.some(
                (_, index) =>
                  (!rule.directory || index < parts.length - 1) &&
                  matches(rule.pattern, parts.slice(0, index + 1).join("/")),
              )
              return hit ? !rule.negate : ignored
            }, false)
            return { ...object, relative, ignored }
          })
          .filter((object) => !object.relative.split("/").includes(".git"))
      })

      const entries = (input: Ripgrep.FindInput, glob: boolean) =>
        abortable(
          Effect.gen(function* () {
            const objects = yield* candidates(input.cwd)
            const result = objects
              .filter((object) => {
                if (!input.hidden && object.relative.split("/").some((part) => part.startsWith("."))) {
                  // Explicit find globs, unlike a catch-all find, can opt into hidden files.
                  if (glob || input.pattern === "*") return false
                }
                if (object.ignored && (input.pattern === "*" || !matches(input.pattern, object.relative))) return false
                return (
                  matches(input.pattern, object.relative) &&
                  !(input.exclude ?? []).some((pattern) => matches(pattern, object.relative))
                )
              })
              .slice(0, Math.max(0, input.limit))
              .map((object) =>
                Entry.make({
                  path: RelativePath.make(object.relative),
                  type: "file",
                }),
              )
            if (input.onEntry) yield* Effect.forEach(result, input.onEntry, { discard: true })
            return result
          }),
          input.signal,
        ).pipe(Effect.mapError((cause) => new Ripgrep.Error({ message: cause.message, cause })))

      const run = Effect.fnUntraced(function* (
        input: Ripgrep.GrepInput,
        object?: { path: string; relative: string; info: { size: number } },
      ) {
        const content =
          object && object.info.size > 0
            ? Stream.range(0, Math.ceil(object.info.size / CHUNK_BYTES) - 1).pipe(
                Stream.mapEffect((index) =>
                  files
                    .read(object.path, {
                      offset: index * CHUNK_BYTES,
                      length: Math.min(CHUNK_BYTES, object.info.size - index * CHUNK_BYTES),
                    })
                    .pipe(
                      Effect.flatMap((result) =>
                        result.bytes.length === 0
                          ? Effect.fail(new Ripgrep.Error({ message: `Unexpected end of S3 object: ${object.path}` }))
                          : Effect.succeed(result.bytes),
                      ),
                    ),
                ),
              )
            : Stream.empty
        // Never set cwd to the virtual workspace or pass an object path to rg.
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            yield* binary.filepath,
            [
              "--no-config",
              "--json",
              ...(input.literal ? ["--fixed-strings"] : []),
              ...(input.caseSensitive === false ? ["--ignore-case"] : []),
              "--",
              input.pattern,
              "-",
            ],
            { extendEnv: true, stdin: { stream: "pipe", endOnDone: true } },
          ),
        )
        const feed = yield* Stream.run(content, handle.stdin).pipe(Effect.forkScoped)
        const stderr = yield* collectStream(handle.stderr, 8192).pipe(Effect.forkScoped)
        const result = yield* Stream.decodeText(handle.stdout).pipe(
          Stream.splitLines,
          Stream.filter((line) => line.length > 0),
          Stream.mapEffect((line) =>
            decodeJson(line).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.undefined
                return decodeMatch(json).pipe(
                  Effect.map((row) =>
                    Match.make({
                      entry: Entry.make({ path: RelativePath.make(object?.relative ?? "stdin"), type: "file" }),
                      line: row.data.line_number,
                      offset: row.data.absolute_offset,
                      text:
                        row.data.lines.text.length > 2000
                          ? row.data.lines.text.slice(0, 2000) + "..."
                          : row.data.lines.text,
                      submatches: row.data.submatches
                        .slice(0, 100)
                        .map((item) => ({ text: item.match.text, start: item.start, end: item.end })),
                    }),
                  ),
                )
              }),
            ),
          ),
          Stream.filter((row): row is Match => row !== undefined),
          Stream.take(Math.max(1, input.limit + 1)),
          Stream.runCollect,
          Effect.raceFirst(Fiber.join(feed).pipe(Effect.andThen(Effect.never))),
        )
        if (result.length > input.limit) return result.slice(0, Math.max(0, input.limit))
        const code = yield* handle.exitCode
        const error = (yield* Fiber.join(stderr)).buffer.toString("utf8").trim()
        if (code === 2 && (error.includes("regex parse error") || error.includes("error parsing regex")))
          return yield* new Ripgrep.InvalidPatternError({ pattern: input.pattern, message: error })
        if (code !== 0 && code !== 1)
          return yield* new Ripgrep.Error({ message: error || `ripgrep failed with code ${code}` })
        return result
      }, Effect.scoped)

      return Ripgrep.Service.of({
        find: (input) => entries(input, false),
        glob: (input) => entries(input, true),
        grep: (input) =>
          abortable(
            Effect.gen(function* () {
              // Validate with rg even when the bucket is empty or the include matches nothing.
              yield* run({ ...input, limit: 1 })
              const root = path.posix.resolve(input.cwd)
              const selected = input.file ? path.posix.resolve(root, input.file) : undefined
              const info = selected ? yield* files.stat(selected) : undefined
              const objects =
                selected && info?.type === "file"
                  ? [{ path: selected, relative: path.posix.relative(root, selected), info, ignored: false }]
                  : (yield* candidates(root)).filter((object) => !selected || object.path.startsWith(`${selected}/`))
              const result: Match[] = []
              for (const object of objects) {
                if (result.length >= input.limit) break
                const relative = path.posix.relative(root, object.path)
                if (relative.split("/").includes(".git")) continue
                if (input.include && !matches(input.include, relative)) continue
                if (object.ignored && !input.include) continue
                result.push(...(yield* run({ ...input, limit: input.limit - result.length }, { ...object, relative })))
              }
              return result
            }),
            input.signal,
          ),
      })
    }),
  )
