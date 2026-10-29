import { expect } from "bun:test"
import path from "node:path"
import { Effect, Schema } from "effect"
import { S3Files } from "@opencode/core/environment/s3"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { AbsolutePath } from "@opencode/schema/schema"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { hasS3Fixture, s3Fixture } from "../../core/test/fixture/s3"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// Opt in explicitly: an unavailable or partially configured endpoint must fail, not silently skip.
const enabled = hasS3Fixture() || Object.keys(process.env).some((key) => key.startsWith("OPENCODE_TEST_S3_"))
const live = enabled ? it.live : it.live.skip

const fixture = Effect.fnUntraced(function* () {
  const required = (field: string) => {
    const value = process.env[`OPENCODE_TEST_S3_${field}`]
    if (!value) throw new Error(`Missing OPENCODE_TEST_S3_${field}`)
    return value
  }
  const tmp = yield* tmpdirScoped()
  const minio = hasS3Fixture()
    ? yield* Effect.acquireDisposable(Effect.promise(s3Fixture))
    : undefined
  const s3 = {
    endpoint: minio?.endpoint ?? required("ENDPOINT"),
    bucket: minio?.bucket ?? required("BUCKET"),
    accessKeyId: minio?.accessKeyId ?? required("ACCESS_KEY_ID"),
    secretAccessKey: minio?.secretAccessKey ?? required("SECRET_ACCESS_KEY"),
    region: process.env.OPENCODE_TEST_S3_REGION ?? "us-east-1",
    prefix: `http-integration-${crypto.randomUUID()}`,
  }
  const files = S3Files.make(s3)
  // The adapter confines this removal to this test's unique prefix, never the bucket.
  yield* Effect.addFinalizer(() => files.remove("/workspace").pipe(Effect.orDie))
  return {
    files,
    uri: (name: string) => `s3://${s3.bucket}/${s3.prefix}/${name}`,
    options: {
      s3,
      app: { version: "s3-integration-test" },
      database: { path: path.join(tmp.path, "server.sqlite") },
      config: { directory: path.join(tmp.path, "config"), project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    },
  }
})

function request(handler: (request: Request) => Promise<Response>) {
  return (endpoint: string, init?: RequestInit) =>
    Effect.promise(() => handler(new Request(`http://opencode.local${endpoint}`, init)))
}

function prompt(uris: readonly string[]) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Inspect uploaded files", files: uris.map((uri) => ({ uri })), resume: false }),
  }
}

live(
  "S3 HTTP profile reads, writes, admits uploaded attachments and reconnects without local workspace files",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const text = "Only in S3: first line\nsecond line\n"
      const pdf = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"
      yield* test.files.write("/workspace/input/notes.txt", Buffer.from(text))
      yield* test.files.write("/workspace/input/document.pdf", Buffer.from(pdf))

      const session = yield* Effect.scoped(
        Effect.gen(function* () {
          const http = request(yield* ServerFetch.make(test.options))
          const full = yield* http("/api/fs/read/input/notes.txt")
          expect(full.status).toBe(200)
          expect(yield* Effect.promise(() => full.text())).toBe(text)

          const partial = yield* http("/api/fs/read/input/notes.txt", { headers: { Range: "bytes=2-8" } })
          expect(partial.status).toBe(206)
          expect(partial.headers.get("content-range")).toBe(`bytes 2-8/${Buffer.byteLength(text)}`)
          expect(yield* Effect.promise(() => partial.text())).toBe(text.slice(2, 9))
          const unsatisfiable = yield* http("/api/fs/read/input/notes.txt", { headers: { Range: "bytes=999-" } })
          expect(unsatisfiable.status).toBe(416)

          const listed = yield* http("/api/fs/list?path=input")
          expect(listed.status).toBe(200)
          expect(yield* Effect.promise(() => listed.json())).toMatchObject({
            location: { directory: "/workspace" },
            data: [
              { path: "input/document.pdf", type: "file" },
              { path: "input/notes.txt", type: "file" },
            ],
          })

          const written = yield* http("/api/experimental/fs/write?path=output/result.txt", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: "written through HTTP",
          })
          expect(written.status).toBe(200)
          expect(Buffer.from((yield* test.files.read("/workspace/output/result.txt")).bytes).toString()).toBe(
            "written through HTTP",
          )

          const created = yield* http("/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
          expect({
            status: created.status,
            error: created.ok ? undefined : yield* Effect.promise(() => created.clone().text()),
          }).toEqual({ status: 200, error: undefined })
          const session = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
            yield* Effect.promise(() => created.json()),
          ).data
          expect(session.location.directory).toBe(AbsolutePath.make("/workspace"))

          const admitted = yield* http(
            `/api/session/${session.id}/prompt`,
            prompt([test.uri("input/notes.txt"), test.uri("input/document.pdf")]),
          )
          expect(admitted.status).toBe(200)
          const item = Schema.decodeUnknownSync(Schema.Struct({ data: SessionInbox.User }))(
            yield* Effect.promise(() => admitted.json()),
          ).data
          expect(item.payload.files).toMatchObject([
            {
              mime: "text/plain",
              data: Buffer.from(text).toString("base64"),
              source: { type: "uri", uri: test.uri("input/notes.txt") },
            },
            {
              mime: "application/pdf",
              data: Buffer.from(pdf).toString("base64"),
              source: { type: "uri", uri: test.uri("input/document.pdf") },
            },
          ])
          return session
        }),
      )

      // Close the first graph before reopening the same database: there is only one writer.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const http = request(yield* ServerFetch.make(test.options))
          const found = yield* http(`/api/session/${session.id}`)
          expect(found.status).toBe(200)
          expect(yield* Effect.promise(() => found.json())).toMatchObject({
            data: { id: session.id, location: session.location },
          })
          const inbox = yield* http(`/api/session/${session.id}/inbox`)
          expect(inbox.status).toBe(200)
          const pending = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(SessionInbox.Info) }))(
            yield* Effect.promise(() => inbox.json()),
          ).data
          expect(pending).toHaveLength(1)
          expect(pending[0]).toMatchObject({
            type: "user",
            payload: {
              text: "Inspect uploaded files",
              files: [
                {
                  mime: "text/plain",
                  data: Buffer.from(text).toString("base64"),
                  source: { type: "uri", uri: test.uri("input/notes.txt") },
                },
                {
                  mime: "application/pdf",
                  data: Buffer.from(pdf).toString("base64"),
                  source: { type: "uri", uri: test.uri("input/document.pdf") },
                },
              ],
            },
          })
          const reread = yield* http("/api/fs/read/output/result.txt")
          expect(reread.status).toBe(200)
          expect(yield* Effect.promise(() => reread.text())).toBe("written through HTTP")
        }),
      )
    }),
  // MinIO startup, actual S3 network I/O and two complete server graph/database lifecycles.
  60_000,
)

live(
  "S3 HTTP attachment admission rejects missing, outside-prefix, host-local and oversized objects",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.files.write("/workspace/oversized.txt", new Uint8Array(20 * 1024 * 1024 + 1))
      const http = request(yield* ServerFetch.make(test.options))
      const created = yield* http("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: { directory: "/workspace" } }),
      })
      expect({
        status: created.status,
        error: created.ok ? undefined : yield* Effect.promise(() => created.clone().text()),
      }).toEqual({ status: 200, error: undefined })
      const session = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => created.json()),
      ).data
      for (const uri of [
        test.uri("missing.txt"),
        `s3://${test.options.s3.bucket}/outside-${crypto.randomUUID()}/secret.txt`,
        "file:///etc/hosts",
        test.uri("oversized.txt"),
      ]) {
        const rejected = yield* http(`/api/session/${session.id}/prompt`, prompt([uri]))
        expect({ uri, status: rejected.status }).toEqual({ uri, status: 400 })
        expect(yield* Effect.promise(() => rejected.json())).toMatchObject({ _tag: "InvalidRequestError" })
      }
      const inbox = yield* http(`/api/session/${session.id}/inbox`)
      expect(inbox.status).toBe(200)
      expect(yield* Effect.promise(() => inbox.json())).toMatchObject({ data: [] })
      const missing = yield* http("/api/fs/read/missing.txt")
      expect(missing.status).toBe(404)
    }),
  // MinIO startup and upload of the real 20 MiB guard-crossing object.
  60_000,
)
