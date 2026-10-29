import { Context, Effect, Layer } from "effect"
import { Info, Ref, response } from "@opencode/schema/location"
import { Project } from "./project.js"
import { S3Workspace } from "./workspace/s3.js"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode, tags } from "@opencode/util/effect/app-node"

export * as Location from "./location.js"

export { Info, Ref, response }

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const placement = yield* S3Workspace.Service
      if (placement.backend && !placement.accepts(ref))
        return yield* Effect.die(new Error("S3 cannot reuse a local or foreign workspace location"))
      const bound = placement.bind(ref)
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        directory: bound.directory,
        workspaceID: bound.workspaceID,
        project: { id: resolved.id, directory: resolved.directory, canonical: resolved.canonical },
        vcs: resolved.vcs,
      })
    }),
  )

export const boundNode = (ref: Ref) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [Project.node, S3Workspace.node],
  })
