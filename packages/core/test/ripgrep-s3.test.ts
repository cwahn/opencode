import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { makeFiles } from "@opencode/core/environment/index"
import { makeMemoryDriver } from "@opencode/core/environment/memory"
import { Failed } from "@opencode/core/environment/files"
import type { S3Files } from "@opencode/core/environment/s3"
import { Ripgrep } from "@opencode/core/ripgrep"
import { RipgrepBinary } from "@opencode/core/ripgrep/binary"
import { S3Ripgrep } from "@opencode/core/ripgrep/s3"
import { RelativePath } from "@opencode/core/schema"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { it } from "./lib/effect"

// A real in-process Files driver: no local workspace fixture and no module mocks.
const fixture = (contents: Record<string, string>) =>
  Effect.gen(function* () {
    const memory = makeFiles(makeMemoryDriver())
    yield* memory.mkdir("/workspace")
    yield* Effect.forEach(Object.entries(contents), ([name, text]) =>
      memory.write(`/workspace/${name}`, new TextEncoder().encode(text)),
    )
    const walk: ReturnType<typeof S3Files.make>["walk"] = (root) =>
      Effect.gen(function* () {
        const children = yield* memory.list(root)
        const nested = yield* Effect.forEach(children, (child) =>
          Effect.gen(function* () {
            const pathname = `${root}/${child.name}`
            if (child.type === "directory") return yield* walk(pathname)
            return [{ path: pathname, info: yield* memory.stat(pathname) }]
          }),
        )
        return nested.flat()
      })
    const files = { ...memory, walk, fromUri: () => undefined }
    const dependencies = Layer.merge(
      AppNodeBuilder.build(CrossSpawnSpawner.node),
      Layer.succeed(RipgrepBinary.Service, { filepath: Effect.succeed("rg") }),
    )
    return { files, layer: S3Ripgrep.layer(files).pipe(Layer.provide(dependencies)) }
  })

describe("S3 ripgrep", () => {
  it.live(
    "enumerates virtual objects with globs, hidden filtering, ignore files and limits",
    Effect.gen(function* () {
      const data = yield* fixture({
        "src/a.ts": "needle\n",
        "src/b.txt": "needle\n",
        ".hidden.ts": "needle\n",
        ".secret/a.ts": "needle\n",
        ".git/config.ts": "needle\n",
        ".gitignore": "vendor/\n",
        "vendor/a.ts": "needle\n",
      })
      yield* Effect.gen(function* () {
        const search = yield* Ripgrep.Service
        expect(
          (yield* search.glob({ cwd: "/workspace", pattern: "src/*.{ts,txt}", limit: 10 })).map((row) => row.path),
        ).toEqual(["src/a.ts", "src/b.txt"].map((name) => RelativePath.make(name)))
        expect(
          (yield* search.glob({ cwd: "/workspace", pattern: "**/*.ts", limit: 1 })).map((row) => row.path),
        ).toEqual([RelativePath.make("src/a.ts")])
        expect(
          (yield* search.glob({ cwd: "/workspace", pattern: "**/*.ts", hidden: true, limit: 10 }))
            .map((row) => row.path)
            .sort(),
        ).toEqual([".hidden.ts", ".secret/a.ts", "src/a.ts", "vendor/a.ts"].map((name) => RelativePath.make(name)))
        const observed: string[] = []
        const found = yield* search.find({
          cwd: "/workspace",
          pattern: "*",
          limit: 10,
          exclude: ["*.txt"],
          onEntry: (entry) =>
            Effect.sync(() => {
              observed.push(entry.path)
            }),
        })
        expect(found.map((row) => row.path)).toEqual([RelativePath.make("src/a.ts")])
        expect(observed).toEqual(["src/a.ts"])
      }).pipe(Effect.provide(data.layer))
    }),
  )

  it.live(
    "uses rg regex semantics on stdin and preserves lines, offsets, paths and fixed strings",
    Effect.gen(function* () {
      const data = yield* fixture({
        "src/a.ts": "other\nNeedle 123\na.b\naxb\n",
        "src/skip.txt": "Needle 456\n",
        ".hidden": "Needle 789\n",
        ".git/config": "Needle 000\n",
      })
      yield* Effect.gen(function* () {
        const search = yield* Ripgrep.Service
        const rows = yield* search.grep({
          cwd: "/workspace",
          pattern: "needle \\d+",
          caseSensitive: false,
          include: "*.ts",
          limit: 10,
        })
        expect(rows).toHaveLength(1)
        expect(rows[0]?.entry.path).toBe(RelativePath.make("src/a.ts"))
        expect(rows[0]?.line).toBe(2)
        expect(rows[0]?.offset).toBe(6)
        expect(rows[0]?.submatches).toEqual([{ text: "Needle 123", start: 0, end: 10 }])
        expect(yield* search.grep({ cwd: "/workspace", pattern: "needle", caseSensitive: true, limit: 10 })).toEqual([])
        expect(
          (yield* search.grep({ cwd: "/workspace", file: "src/a.ts", pattern: "a.b", literal: true, limit: 10 })).map(
            (row) => row.text,
          ),
        ).toEqual(["a.b\n"])
        expect(
          (yield* search.grep({ cwd: "/workspace", file: "/workspace/src", pattern: "a.b", limit: 1 })).map(
            (row) => row.text,
          ),
        ).toEqual(["a.b\n"])
        expect(
          (yield* search.grep({ cwd: "/workspace", pattern: "Needle", limit: 10 })).map((row) => row.entry.path).sort(),
        ).toEqual([".hidden", "src/a.ts", "src/skip.txt"].map((name) => RelativePath.make(name)))
      }).pipe(Effect.provide(data.layer))
    }),
  )

  it.live(
    "validates invalid regex even with no candidate objects, and reports missing paths",
    Effect.gen(function* () {
      const data = yield* fixture({})
      yield* Effect.gen(function* () {
        const search = yield* Ripgrep.Service
        const invalid = yield* search.grep({ cwd: "/workspace", pattern: "[", limit: 10 }).pipe(Effect.flip)
        expect(invalid._tag).toBe("Ripgrep.InvalidPatternError")
        expect(yield* search.grep({ cwd: "/workspace", pattern: "[", literal: true, limit: 10 })).toEqual([])
        const missing = yield* search
          .grep({ cwd: "/workspace", file: "missing", pattern: "needle", limit: 10 })
          .pipe(Effect.flip)
        expect(missing._tag).toBe("Ripgrep.Error")
      }).pipe(Effect.provide(data.layer))
    }),
  )

  it.live(
    "streams large objects in bounded ranges",
    Effect.gen(function* () {
      const data = yield* fixture({ "large.txt": "x".repeat(256 * 1024) + "\nneedle\n" })
      const ranges: number[] = []
      const files = {
        ...data.files,
        read: (name: string, range?: { offset: number; length: number }) => {
          if (range) ranges.push(range.length)
          return data.files.read(name, range)
        },
      }
      const host = Layer.merge(
        AppNodeBuilder.build(CrossSpawnSpawner.node),
        Layer.succeed(RipgrepBinary.Service, { filepath: Effect.succeed("rg") }),
      )
      yield* Effect.gen(function* () {
        const search = yield* Ripgrep.Service
        const rows = yield* search.grep({ cwd: "/workspace", pattern: "needle", limit: 10 })
        expect(rows[0]?.line).toBe(2)
        expect(ranges).toEqual([256 * 1024, 8])
        yield* data.files.remove("/workspace/large.txt")
        expect(yield* search.grep({ cwd: "/workspace", pattern: "needle", limit: 10 })).toEqual([])
      }).pipe(Effect.provide(S3Ripgrep.layer(files).pipe(Layer.provide(host))))
    }),
  )

  it.live(
    "propagates stdin source failures and aborts an in-flight object read",
    Effect.gen(function* () {
      const data = yield* fixture({ "file.txt": "needle\n" })
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const controller = new AbortController()
      const host = Layer.merge(
        AppNodeBuilder.build(CrossSpawnSpawner.node),
        Layer.succeed(RipgrepBinary.Service, { filepath: Effect.succeed("rg") }),
      )
      const broken = {
        ...data.files,
        read: () => Effect.fail(new Failed({ path: "/workspace/file.txt", cause: "offline" })),
      }
      yield* Effect.gen(function* () {
        const search = yield* Ripgrep.Service
        expect((yield* search.grep({ cwd: "/workspace", pattern: "needle", limit: 10 }).pipe(Effect.flip))._tag).toBe(
          "Ripgrep.Error",
        )
      }).pipe(Effect.provide(S3Ripgrep.layer(broken).pipe(Layer.provide(host))))
      const blocked = {
        ...data.files,
        read: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      }
      yield* Effect.gen(function* () {
        const search = yield* Ripgrep.Service
        const pending = yield* search
          .grep({ cwd: "/workspace", pattern: "needle", limit: 10, signal: controller.signal })
          .pipe(Effect.flip, Effect.forkChild)
        yield* Deferred.await(started)
        controller.abort()
        expect((yield* Fiber.join(pending))._tag).toBe("Ripgrep.Error")
        yield* Deferred.await(stopped)
      }).pipe(Effect.provide(S3Ripgrep.layer(blocked).pipe(Layer.provide(host))))
    }),
  )
})
