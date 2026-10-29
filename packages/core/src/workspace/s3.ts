export * as S3Workspace from "./s3.js"

import { Context, Layer } from "effect"
import { createHash } from "node:crypto"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { S3Files } from "../environment/s3.js"
import { Location } from "@opencode/schema/location"
import { Workspace } from "@opencode/schema/workspace"
import { ProjectSchema } from "../project/schema.js"
import { AbsolutePath } from "../schema.js"

export type Backend = {
  readonly files: ReturnType<typeof S3Files.make>
  readonly identity: string
  readonly workspaceID: Workspace.ID
  readonly projectID: ProjectSchema.ID
  readonly root: AbsolutePath
}

export interface Interface {
  readonly backend?: Backend
  readonly bind: (ref: Location.Ref) => Location.Ref
  readonly accepts: (ref: Location.Ref) => boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/S3Workspace") {}

export function identity(options: S3Files.Options) {
  return createHash("sha256")
    .update(JSON.stringify([new URL(options.endpoint).href.replace(/\/$/, ""), options.bucket, options.prefix ?? ""]))
    .digest("hex")
}

export function make(options?: S3Files.Options): Interface {
  if (!options) return { bind: (ref) => ref, accepts: () => true }
  const id = identity(options)
  const backend: Backend = {
    files: S3Files.make(options),
    identity: id,
    workspaceID: Workspace.ID.make(`wrk_s3_${id}`),
    projectID: ProjectSchema.ID.make(`s3_${id}`),
    root: AbsolutePath.make(S3Files.ROOT),
  }
  return {
    backend,
    accepts: (ref) => ref.workspaceID === backend.workspaceID,
    bind: (ref) => {
      if (ref.workspaceID && ref.workspaceID !== backend.workspaceID)
        throw new Error("Location belongs to another workspace")
      if (ref.directory !== backend.root && !ref.directory.startsWith(backend.root + "/"))
        throw new Error("S3 directories must be inside /workspace")
      if (
        ref.directory.includes("\\") ||
        ref.directory.includes("\0") ||
        ref.directory.includes("//") ||
        ref.directory.split("/").some((part) => part === ".." || part === ".")
      )
        throw new Error("S3 directory must be canonical")
      return Location.Ref.make({ directory: ref.directory, workspaceID: backend.workspaceID })
    },
  }
}

export const configured = (options?: S3Files.Options) =>
  makeGlobalNode({ service: Service, layer: Layer.sync(Service, () => make(options)), deps: [] })

export const node = configured()
