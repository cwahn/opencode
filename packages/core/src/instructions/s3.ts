export * as S3Instructions from "./s3.js"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "node:path"
import { Bus } from "../bus.js"
import { Environment } from "../environment/index.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Location } from "../location.js"
import { AbsolutePath } from "../schema.js"
import { S3Files } from "../environment/s3.js"

/** Workspace instructions never walk into the server host's ancestors. */
export const node = makeLocationNode({
  service: InstructionDiscovery.Service,
  deps: [Bus.node, Environment.node, Location.node],
  layer: InstructionDiscovery.layer({ project: false, global: false }).pipe(
    Layer.tap((context) =>
      Effect.gen(function* () {
        const discovery = Context.get(context, InstructionDiscovery.Service)
        const environment = yield* Environment.Service
        const location = yield* Location.Service
        const relative = path.posix.relative(S3Files.ROOT, location.directory)
        const parts = relative === "" ? [] : relative.split("/")
        const paths = Array.from({ length: parts.length + 1 }, (_, index) =>
          path.posix.join(S3Files.ROOT, ...parts.slice(0, parts.length - index), "AGENTS.md"),
        )
        const files = yield* Effect.forEach(paths, (file) =>
          environment.files.read(file).pipe(
            Effect.map(
              (result) =>
                new InstructionDiscovery.File({
                  path: AbsolutePath.make(file),
                  content: new TextDecoder().decode(result.bytes),
                }),
            ),
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(undefined)),
            Effect.orDie,
          ),
        )
        yield* discovery.transform((editor) => {
          for (const file of files) if (file) editor.add(file)
        })
      }),
    ),
  ),
})
