export * as ServerS3 from "./s3"

import { Effect, Layer, Schema } from "effect"
import { S3Workspace } from "@opencode/core/workspace/s3"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { EnvironmentUnavailable } from "@opencode/core/environment/unavailable"
import { FileSystem } from "@opencode/core/filesystem"
import { Formatter } from "@opencode/core/formatter"
import { Snapshot } from "@opencode/core/snapshot"
import { Vcs } from "@opencode/core/vcs"
import { Pty } from "@opencode/core/pty"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Worktree } from "@opencode/core/worktree"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { S3Instructions } from "@opencode/core/instructions/s3"
import { Ripgrep } from "@opencode/core/ripgrep"
import { RipgrepBinary } from "@opencode/core/ripgrep/binary"
import { S3Ripgrep } from "@opencode/core/ripgrep/s3"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"

export const Options = Schema.Struct({
  endpoint: Schema.String,
  bucket: Schema.String,
  prefix: Schema.optional(Schema.String),
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  region: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

/** Environment parsing is opt-in, but partial configuration always fails closed. */
export function fromEnv(env: Readonly<Record<string, string | undefined>>): Options | undefined {
  const fields = ["ENDPOINT", "BUCKET", "PREFIX", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "REGION"]
  if (!fields.some((field) => env[`OPENCODE_S3_${field}`] !== undefined)) return
  const required = (field: string) => {
    const value = env[`OPENCODE_S3_${field}`]
    if (!value?.trim()) throw new Error(`Missing OPENCODE_S3_${field}`)
    return value
  }
  return validate({
    endpoint: required("ENDPOINT"),
    bucket: required("BUCKET"),
    prefix: env.OPENCODE_S3_PREFIX,
    accessKeyId: required("ACCESS_KEY_ID"),
    secretAccessKey: required("SECRET_ACCESS_KEY"),
    region: env.OPENCODE_S3_REGION,
  })
}

export function validate(options: Options): Options {
  const endpoint = URL.parse(options.endpoint)
  if (
    !endpoint ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "OPENCODE_S3_ENDPOINT must be a bucket-scoped HTTP(S) endpoint without credentials, query or fragment",
    )
  if (
    !options.bucket.trim() ||
    options.bucket.includes("/") ||
    !options.accessKeyId.trim() ||
    !options.secretAccessKey.trim()
  )
    throw new Error("S3 bucket and credentials must be nonempty")
  if (options.region !== undefined && !options.region.trim()) throw new Error("OPENCODE_S3_REGION must be nonempty")
  const prefix = options.prefix?.replace(/\/+$/, "") ?? ""
  if (
    prefix.startsWith("/") ||
    prefix.split("/").some((part) => part === "." || part === ".." || (part === "" && prefix !== "")) ||
    prefix.includes("\\") ||
    prefix.includes("\0")
  )
    throw new Error("OPENCODE_S3_PREFIX must be a relative canonical object prefix")
  return { ...options, endpoint: endpoint.href.replace(/\/$/, ""), prefix }
}

const unavailable = () => Effect.die(new Error("Unavailable in the S3 file-only profile"))

export function replacements(options: Options): LayerNode.Replacements {
  const placement = S3Workspace.make(validate(options))
  const backend = placement.backend
  if (!backend) throw new Error("Missing S3 backend")
  const driver = WorkspaceDriver.make({
    create: () => Effect.succeed({ binding: { identity: backend.identity } }),
    connect: ({ workspaceID, binding }) =>
      workspaceID === backend.workspaceID && binding.identity === backend.identity
        ? Effect.succeed({ spawner: EnvironmentUnavailable.spawner, overrides: backend.files })
        : Effect.fail(new WorkspaceDriver.Error({ message: "S3 workspace identity mismatch" })),
    suspendForIdle: () => Effect.void,
    destroy: () => Effect.void,
  })
  const terminalUnavailable = () =>
    Effect.fail(new PersistentPty.UnavailableError({ message: "S3 has no execution plane" }))
  return [
    S3Workspace.node.replace(Layer.succeed(S3Workspace.Service, placement)),
    WorkspaceDriver.node.replace(WorkspaceDriver.registryNode({ s3: driver })),
    FileSystem.node.replace(FileSystem.environmentNode),
    Ripgrep.node.replace(
      makeLocationNode({
        service: Ripgrep.Service,
        layer: S3Ripgrep.layer(backend.files),
        deps: [RipgrepBinary.node, CrossSpawnSpawner.node],
      }),
    ),
    Snapshot.node.replace(Snapshot.noopLayer),
    Formatter.node.replace(
      Layer.succeed(Formatter.Service, {
        file: () => Effect.succeed(false),
        transform: () => Effect.succeed({ dispose: Effect.void }),
        reload: () => Effect.void,
      }),
    ),
    Vcs.node.replace(
      Layer.succeed(Vcs.Service, {
        base: () => Effect.succeed(null),
        initialize: () => Effect.fail(new Vcs.InitializeError({ kind: "unsupported" })),
        transform: () => Effect.succeed({ dispose: Effect.void }),
        reload: () => Effect.void,
        info: () => Effect.succeed({ branch: {} }),
        branches: () => Effect.succeed([]),
        status: () => Effect.succeed([]),
        diff: () => Effect.succeed([]),
      }),
    ),
    Worktree.node.replace(
      Layer.succeed(Worktree.Service, {
        list: () => unavailable(),
        create: unavailable,
        remove: unavailable,
        refresh: unavailable,
      }),
    ),
    Pty.node.replace(
      Layer.succeed(Pty.Service, {
        list: () => Effect.succeed([]),
        get: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
        create: unavailable,
        update: unavailable,
        remove: unavailable,
        write: unavailable,
        attach: unavailable,
      }),
    ),
    PersistentPty.node.replace(
      Layer.succeed(PersistentPty.Service, {
        list: () => Effect.succeed([]),
        get: terminalUnavailable,
        create: terminalUnavailable,
        write: terminalUnavailable,
        resize: terminalUnavailable,
        control: terminalUnavailable,
        input: terminalUnavailable,
        snapshot: terminalUnavailable,
        read: terminalUnavailable,
        remove: terminalUnavailable,
        shutdown: () => Effect.void,
        handoff: () => Effect.succeed(null),
        attach: terminalUnavailable,
      }),
    ),
    ConfigPluginSource.node.replace(ConfigPluginSource.empty),
    InstructionDiscovery.node.replace(S3Instructions.node),
  ]
}
