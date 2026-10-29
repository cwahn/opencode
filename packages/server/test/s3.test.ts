import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import path from "node:path"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/core/schema"
import { S3Workspace } from "@opencode/core/workspace/s3"
import { S3Files } from "@opencode/core/environment/s3"
import { Ripgrep } from "@opencode/core/ripgrep"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { RelativePath } from "@opencode/core/schema"
import { it } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { hasS3Fixture, s3Fixture } from "../../core/test/fixture/s3"
import { ServerS3 } from "../src/s3"
import { ServerFetch } from "../src/fetch"

const options = {
  endpoint: "http://127.0.0.1:1/bucket",
  bucket: "bucket",
  prefix: "tenant",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
}

test("S3 opt-in fails closed on incomplete or unsafe environment configuration", () => {
  expect(ServerS3.fromEnv({})).toBeUndefined()
  expect(() => ServerS3.fromEnv({ OPENCODE_S3_BUCKET: "bucket" })).toThrow("OPENCODE_S3_ENDPOINT")
  for (const endpoint of ["file:///workspace", "https://secret@example.com", "https://example.com?secret=value"])
    expect(() => ServerS3.validate({ ...options, endpoint })).toThrow()
  for (const prefix of ["/tenant", "tenant/../other", "tenant\\other"])
    expect(() => ServerS3.validate({ ...options, prefix })).toThrow()
})

test("S3 placement binds one backend without credentials in its durable identity", () => {
  const placement = S3Workspace.make(options)
  const rotated = S3Workspace.make({ ...options, secretAccessKey: "rotated", accessKeyId: "rotated" })
  expect(rotated.backend?.workspaceID).toBe(placement.backend?.workspaceID)
  expect(S3Workspace.make({ ...options, prefix: "other" }).backend?.workspaceID).not.toBe(
    placement.backend?.workspaceID,
  )
  const ref = Location.Ref.make({ directory: AbsolutePath.make("/workspace/nested") })
  expect(placement.accepts(ref)).toBe(false)
  expect(placement.accepts(placement.bind(ref))).toBe(true)
  for (const directory of ["/tmp", "/workspace/../tmp", "/workspace-other"])
    expect(() => placement.bind(Location.Ref.make({ directory: AbsolutePath.make(directory) }))).toThrow()
})

it.live("S3 HTTP sessions retain fixed internal placement and isolate backend databases", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-s3-profile-")))
    const common = {
      database: { path: path.join(directory.path, "sessions.db") },
      config: { directory: directory.path },
      models: { fetch: false },
    }
    const handler = yield* ServerFetch.make({ ...common, s3: options })
    const created = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    )
    expect(created.status).toBe(200)
    const session = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
      yield* Effect.promise(() => created.json()),
    ).data
    // Placement remains internal: the public session wire contract deliberately omits workspaceID.
    expect(session.location.directory).toBe(AbsolutePath.make("/workspace"))
    expect(String(session.projectID)).toBe(String(S3Workspace.make(options).backend?.projectID))
    const child = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentID: session.id }),
        }),
      ),
    )
    expect(child.status).toBe(200)
    const childSession = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
      yield* Effect.promise(() => child.json()),
    ).data
    expect(childSession.location.directory).toBe(AbsolutePath.make("/workspace"))
    expect(childSession.projectID).toBe(session.projectID)
    const moved = yield* Effect.promise(() =>
      handler(
        new Request(`http://opencode.local/api/session/${session.id}/move`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: directory.path }),
        }),
      ),
    )
    expect(moved.status).toBe(400)
    const imported = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/experimental/session/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            info: { ...Schema.encodeSync(Session.Info)(session), id: Session.ID.create() },
            messages: [],
          }),
        }),
      ),
    )
    expect(imported.status).toBe(200)
    const importedSession = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
      yield* Effect.promise(() => imported.json()),
    ).data
    expect(importedSession.projectID).toBe(session.projectID)
    expect(importedSession.location.directory).toBe(AbsolutePath.make("/workspace"))
    const other = yield* ServerFetch.make({ ...common, s3: { ...options, prefix: "other" } })
    const missing = yield* Effect.promise(() => other(new Request(`http://opencode.local/api/session/${session.id}`)))
    expect(missing.status).toBe(404)
  }),
)

const liveS3 = hasS3Fixture() ? it.live : it.live.skip

liveS3("S3 profile wires HTTP find and location graph glob/grep to the object backend", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-s3-search-profile-")))
    const s3 = yield* Effect.acquireDisposable(Effect.promise(s3Fixture))
    const files = S3Files.make(s3)
    yield* Effect.addFinalizer(() => files.remove("/workspace").pipe(Effect.orDie))
    yield* files.write("/workspace/src/object-only.ts", Buffer.from("first line\nS3 needle 123\n"))
    const serverOptions = {
      s3,
      database: { path: ":memory:" },
      config: { directory: directory.path },
      models: { fetch: false },
    }
    const handler = yield* ServerFetch.make(serverOptions)
    const response = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/fs/find?query=object-only&type=file&limit=10")),
    )
    expect({ status: response.status, body: yield* Effect.promise(() => response.json()) }).toMatchObject({
      status: 200,
      body: { location: { directory: "/workspace" }, data: [{ path: "src/object-only.ts", type: "file" }] },
    })

    yield* Effect.gen(function* () {
      const search = yield* Ripgrep.Service
      expect(
        (yield* search.glob({ cwd: "/workspace", pattern: "**/*.ts", limit: 10 })).map((entry) => entry.path),
      ).toEqual([RelativePath.make("src/object-only.ts")])
      const matches = yield* search.grep({ cwd: "/workspace", pattern: "needle \\d+", limit: 10 })
      expect(matches.map((match) => ({ path: match.entry.path, line: match.line, text: match.text }))).toEqual([
        { path: RelativePath.make("src/object-only.ts"), line: 2, text: "S3 needle 123\n" },
      ])
    }).pipe(Effect.provide(AppNodeBuilder.build(Ripgrep.node, ServerS3.replacements(s3))))
  }),
)
