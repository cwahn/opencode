import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { FileSystem } from "@opencode/core/filesystem"
import { FileSystemSearch } from "@opencode/core/filesystem/search"
import { Location } from "@opencode/core/location"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { Workspace } from "@opencode/core/workspace"
import { location } from "./fixture/location"
import { it } from "./lib/effect"

describe("workspace filesystem HTTP service", () => {
  it.effect("reads ranges, lists and writes through its environment without a host directory", () =>
    Effect.gen(function* () {
      const driver = Environment.makeMemoryDriver()
      const files = Environment.makeFiles(driver)
      yield* files.write("/workspace/한글/data.bin", new Uint8Array([0, 1, 2, 3, 4]))
      const program = Effect.gen(function* () {
        const filesystem = yield* FileSystem.Service
        const file = yield* filesystem.read({ path: RelativePath.make("한글/data.bin") })
        expect(file.size).toBe(5)
        expect(yield* Stream.mkUint8Array(file.stream({ offset: 1, bytesToRead: 3 }))).toEqual(
          new Uint8Array([1, 2, 3]),
        )
        expect(yield* Stream.mkUint8Array(file.stream({ offset: 5 }))).toHaveLength(0)
        expect(yield* filesystem.list()).toMatchObject([{ path: "한글/", type: "directory" }])
        expect(yield* filesystem.write({ path: "next.txt", data: new TextEncoder().encode("remote") })).toEqual({
          path: AbsolutePath.make("/workspace/next.txt"),
        })
        expect(new TextDecoder().decode((yield* files.read("/workspace/next.txt")).bytes)).toBe("remote")
        expect(yield* Effect.flip(filesystem.read({ path: RelativePath.make("missing") }))).toBeInstanceOf(
          FileSystem.NotFoundError,
        )
        expect(yield* Effect.flip(filesystem.list({ path: "next.txt" }))).toBeInstanceOf(FileSystem.NotFoundError)
      })

      yield* program.pipe(
        Effect.provide(
          LayerNode.compile(FileSystem.environmentNode, {
            replacements: [
              Environment.node.replace(Layer.succeed(Environment.Service, { files, spawner: driver.spawner })),
              Location.node.replace(
                Layer.succeed(
                  Location.Service,
                  location({
                    directory: AbsolutePath.make("/workspace"),
                    workspaceID: Workspace.ID.make("wrk_filesystem_environment"),
                  }),
                ),
              ),
              FileSystemSearch.node.replace(
                Layer.succeed(FileSystemSearch.Service, { find: () => Effect.succeed([]) }),
              ),
            ],
          }),
        ),
      )
    }),
  )
})
