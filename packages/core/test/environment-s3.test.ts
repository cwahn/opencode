import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { S3mini } from "s3mini"
import { S3Files } from "../src/environment/s3.js"
import type { Options } from "../src/environment/s3.js"
import { hasS3Fixture, s3Fixture, type S3Fixture } from "./fixture/s3.js"
import { it } from "./lib/effect.js"
import { withEnv } from "./fixture/env.js"

const defaults = {
  endpoint: "http://127.0.0.1:1/test",
  bucket: "test",
  accessKeyId: "test",
  secretAccessKey: "test",
  prefix: "tenant/project",
}
const bytes = (value: string) => new TextEncoder().encode(value)

describe("S3 namespace", () => {
  it.effect("required integration coverage cannot silently skip a missing MinIO dependency", () =>
    withEnv(
      {
        OPENCODE_TEST_REQUIRE_S3: "1",
        OPENCODE_TEST_MINIO_BINARY: undefined,
        MINIO_BINARY: undefined,
        OPENCODE_TEST_S3_ENDPOINT: undefined,
        PATH: "/opencode-test-missing-bin",
      },
      () =>
        Effect.sync(() => {
          expect(() => hasS3Fixture()).toThrow("Required S3 test dependency missing")
        }),
    ),
  )

  it.effect("required hermetic coverage rejects externally configured S3 endpoints", () =>
    withEnv({ OPENCODE_TEST_REQUIRE_S3: "1", OPENCODE_TEST_S3_ENDPOINT: "https://external.invalid/bucket" }, () =>
      Effect.sync(() => {
        expect(() => hasS3Fixture()).toThrow("cannot use OPENCODE_TEST_S3_ENDPOINT")
      }),
    ),
  )

  it.effect(
    "maps only raw, contained same-bucket URIs",
    Effect.sync(() => {
      const files = S3Files.make(defaults)
      expect(files.fromUri("s3://test/tenant/project")).toBe("/workspace")
      expect(files.fromUri("s3://test/tenant/project/")).toBe("/workspace")
      expect(files.fromUri("s3://test/tenant/project/hello%20world.txt")).toBe("/workspace/hello world.txt")
      for (const uri of [
        "s3://other/tenant/project/a",
        "s3://test/tenant/project-other/a",
        "s3://test/tenant/project/../a",
        "s3://test/tenant/project/%2e%2e/a",
        "s3://test/tenant/project/a/../../project/b",
        "s3://test/tenant/project/%00",
        "s3://test/tenant/project/%5c..%5ca",
        "s3://test/tenant/project/%",
        "s3://test/tenant/project/a?query",
        "s3://test/tenant/project/a#fragment",
        "https://test/tenant/project/a",
      ])
        expect(files.fromUri(uri)).toBeUndefined()
      expect(S3Files.make({ ...defaults, prefix: undefined }).fromUri("s3://test/a")).toBe("/workspace/a")
      expect(() => S3Files.make({ ...defaults, prefix: "a/../b" })).toThrow()
    }),
  )

  it.effect(
    "rejects escape paths across every operation before HTTP",
    Effect.gen(function* () {
      const files = S3Files.make(defaults)
      for (const path of [
        "/outside",
        "/workspace-other/a",
        "/workspace/../a",
        "/workspace/a/../../b",
        "/workspace/a\0b",
        "/workspace/a\\b",
      ]) {
        const operations = [
          files.stat(path),
          files.read(path),
          files.list(path),
          files.walk(path),
          files.write(path, bytes("x")),
          files.mkdir(path),
          files.remove(path),
          files.move(path, "/workspace/a"),
          files.move("/workspace/a", path),
        ]
        for (const operation of operations) {
          const result = yield* Effect.result(operation)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure._tag).toBe("Environment.Failed")
        }
      }
    }),
  )

  it.live(
    "maps denied HTTP requests to Failed without treating them as missing",
    Effect.gen(function* () {
      const requests: string[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              requests.push(request.method)
              return new Response("denied", { status: 403 })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const files = S3Files.make({ ...defaults, endpoint: `${server.url}test` })
      const result = yield* Effect.result(files.stat("/workspace/a"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("Environment.Failed")
      expect(requests).toEqual(["HEAD"])
    }),
  )

  it.live(
    "rejects ignored, malformed and oversized ranged responses",
    Effect.gen(function* () {
      for (const scenario of ["ignored", "malformed", "oversized", "short", "valid"]) {
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                if (request.method === "HEAD") return new Response(null, { headers: { "content-length": "6" } })
                expect(request.headers.get("range")).toBe("bytes=1-2")
                return new Response(scenario === "oversized" ? "abcdef" : scenario === "short" ? "b" : "bc", {
                  status: scenario === "ignored" ? 200 : 206,
                  headers: { "content-range": scenario === "malformed" ? "bytes 0-1/6" : "bytes 1-2/6" },
                })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const files = S3Files.make({ ...defaults, endpoint: `${server.url}test` })
        const result = yield* Effect.result(files.read("/workspace/file", { offset: 1, length: 2 }))
        if (scenario === "valid") {
          expect(result._tag).toBe("Success")
          if (result._tag === "Success") expect(result.success.bytes).toEqual(bytes("bc"))
          continue
        }
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure._tag).toBe("Environment.Failed")
      }
    }),
  )

  it.live(
    "follows continuation tokens when walking and listing recursive S3 pages",
    Effect.gen(function* () {
      const tokens: Array<string | null> = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              const query = new URL(request.url).searchParams
              expect(query.get("prefix")).toBe("tenant/project/")
              const token = query.get("continuation-token")
              tokens.push(token)
              const indexes = token === null ? Array.from({ length: 1000 }, (_, index) => index) : [1000]
              const contents = indexes
                .map(
                  (index) =>
                    `<Contents><Key>tenant/project/${String(index).padStart(4, "0")}</Key><Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`,
                )
                .join("")
              return new Response(
                `<ListBucketResult><IsTruncated>${token === null}</IsTruncated>${token === null ? "<NextContinuationToken>next</NextContinuationToken>" : ""}${contents}</ListBucketResult>`,
              )
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const files = S3Files.make({ ...defaults, endpoint: `${server.url}test` })
      const walked = yield* files.walk("/workspace")
      expect(walked.length).toBe(1001)
      expect(walked.at(-1)?.path).toBe("/workspace/1000")
      expect((yield* files.list("/workspace")).length).toBe(1001)
      expect(tokens).toEqual([null, "next", null, "next"])
    }),
  )

  it.live(
    "reports copy and delete failures without hiding partial move state",
    Effect.gen(function* () {
      for (const stage of ["copy", "delete"]) {
        const objects = new Set(["/test/tenant/project/source"])
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                const path = new URL(request.url).pathname
                if (request.method === "HEAD")
                  return new Response(null, {
                    status: objects.has(path) ? 200 : 404,
                    headers: { "content-length": "0" },
                  })
                if (request.method === "GET")
                  return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")
                if (request.method === "PUT") {
                  expect(request.headers.get("x-amz-copy-source")).toBe("/test/tenant%2Fproject%2Fsource")
                  if (stage === "copy") return new Response("failed", { status: 500 })
                  objects.add(path)
                  return new Response(
                    '<CopyObjectResult><ETag>"copied"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></CopyObjectResult>',
                  )
                }
                return new Response("denied", { status: 403 })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const files = S3Files.make({ ...defaults, endpoint: `${server.url}test` })
        const result = yield* Effect.result(files.move("/workspace/source", "/workspace/target"))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("Environment.Failed")
          expect(result.failure).toHaveProperty("cause")
        }
        expect(objects.has("/test/tenant/project/source")).toBe(true)
        expect(objects.has("/test/tenant/project/target")).toBe(stage === "delete")
      }
    }),
  )

  it.live(
    "interrupting an operation aborts its in-flight HTTP request",
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Response>()
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
              started.resolve()
              return release.promise
            },
          }),
        ),
        (server) =>
          Effect.sync(() => {
            release.resolve(new Response(null, { status: 404 }))
            server.stop(true)
          }),
      )
      const files = S3Files.make({ ...defaults, endpoint: `${server.url}test` })
      const fiber = yield* files.stat("/workspace/a").pipe(Effect.forkChild)
      yield* Effect.promise(() => started.promise)
      yield* Fiber.interrupt(fiber)
      yield* Effect.promise(() => aborted.promise)
    }),
  )
})

const endpoint = process.env.OPENCODE_TEST_S3_ENDPOINT
const bucket = process.env.OPENCODE_TEST_S3_BUCKET
const accessKeyId = process.env.OPENCODE_TEST_S3_ACCESS_KEY_ID
const secretAccessKey = process.env.OPENCODE_TEST_S3_SECRET_ACCESS_KEY
const integration = hasS3Fixture() || endpoint ? it.live : it.live.skip
const state: { fixture?: S3Fixture; options?: Options } = {}
const options = () => {
  if (!state.options) throw new Error("S3 integration fixture has not started")
  return { ...state.options, prefix: `environment-s3-${crypto.randomUUID()}` }
}

describe("S3 integration (disposable MinIO, or opt-in OPENCODE_TEST_S3_* endpoint)", () => {
  beforeAll(async () => {
    if (endpoint) {
      if (!bucket || !accessKeyId || !secretAccessKey) {
        throw new Error(
          "OPENCODE_TEST_S3_ENDPOINT requires OPENCODE_TEST_S3_BUCKET, OPENCODE_TEST_S3_ACCESS_KEY_ID and OPENCODE_TEST_S3_SECRET_ACCESS_KEY",
        )
      }
      state.options = { endpoint, bucket, accessKeyId, secretAccessKey, region: "us-east-1" }
      return
    }
    if (!hasS3Fixture()) return
    state.fixture = await s3Fixture()
    state.options = state.fixture
  }, 30_000)

  afterAll(async () => {
    await state.fixture?.[Symbol.asyncDispose]()
  })

  integration(
    "reports missing buckets as Failed rather than missing files",
    Effect.gen(function* () {
      const config = options()
      const missing = `missing-${crypto.randomUUID()}`
      const endpoint = new URL(config.endpoint)
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "").slice(0, endpoint.pathname.replace(/\/+$/, "").lastIndexOf("/"))}/${missing}`
      const files = S3Files.make({ ...config, endpoint: endpoint.href, bucket: missing })
      const result = yield* Effect.result(files.stat("/workspace/file"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("Environment.Failed")
    }),
  )

  integration(
    "reads metadata and ranges, retains empty directories and removes trees",
    Effect.gen(function* () {
      const config = options()
      const files = yield* Effect.acquireRelease(
        Effect.sync(() => S3Files.make(config)),
        (files) => files.remove("/workspace").pipe(Effect.orDie),
      )
      expect((yield* files.stat("/workspace")).type).toBe("directory")
      yield* files.mkdir("/workspace/empty/nested")
      yield* files.write("/workspace/tree/file", bytes("abcdef"))
      yield* files.write("/workspace/tree/zero", new Uint8Array())
      const full = yield* files.read("/workspace/tree/file")
      expect(full.bytes).toEqual(bytes("abcdef"))
      expect(full.info.size).toBe(6)
      expect(full.info.mtimeMs).toBeGreaterThan(0)
      for (const [offset, length, expected] of [
        [0, 0, ""],
        [2, 3, "cde"],
        [4, 20, "ef"],
        [6, 2, ""],
        [20, 2, ""],
      ] as const) {
        const result = yield* files.read("/workspace/tree/file", { offset, length })
        expect(result.bytes).toEqual(bytes(expected))
        expect(result.info).toEqual(full.info)
      }
      expect((yield* files.read("/workspace/tree/zero")).bytes.length).toBe(0)
      expect((yield* files.read("/workspace/tree/zero", { offset: 0, length: 1 })).bytes.length).toBe(0)
      expect(yield* files.list("/workspace/empty/nested")).toEqual([])
      expect(yield* files.list("/workspace")).toEqual([
        { name: "empty", type: "directory" },
        { name: "tree", type: "directory" },
      ])
      expect((yield* files.walk("/workspace")).map((entry) => entry.path)).toEqual([
        "/workspace/tree/file",
        "/workspace/tree/zero",
      ])
      yield* files.remove("/workspace/tree")
      expect((yield* files.stat("/workspace/empty/nested")).type).toBe("directory")
      yield* files.remove("/workspace/empty")
      yield* files.remove("/workspace/absent")
      expect(yield* files.list("/workspace")).toEqual([])
    }),
  )

  integration(
    "roundtrips Unicode and URL-significant object names without changing their keys",
    Effect.gen(function* () {
      const config = options()
      const files = yield* Effect.acquireRelease(
        Effect.sync(() => S3Files.make(config)),
        (files) => files.remove("/workspace").pipe(Effect.orDie),
      )
      const name = "한글 & report #1?.txt"
      const target = `/workspace/${name}`
      yield* files.write(target, bytes("업로드된 문서"))
      expect((yield* files.read(target)).bytes).toEqual(bytes("업로드된 문서"))
      expect(yield* files.list("/workspace")).toEqual([{ name, type: "file" }])
      expect((yield* files.walk("/workspace")).map((entry) => entry.path)).toEqual([target])
      expect(files.fromUri(`s3://${config.bucket}/${config.prefix}/${encodeURIComponent(name)}`)).toBe(target)
    }),
  )

  integration(
    "moves files and directory markers by copy then delete",
    Effect.gen(function* () {
      const config = options()
      const files = yield* Effect.acquireRelease(
        Effect.sync(() => S3Files.make(config)),
        (files) => files.remove("/workspace").pipe(Effect.orDie),
      )
      yield* files.mkdir("/workspace/empty/nested")
      yield* files.write("/workspace/tree/file", bytes("abcdef"))
      yield* files.move("/workspace/tree/file", "/workspace/tree/renamed")
      yield* files.move("/workspace/tree", "/workspace/moved")
      expect((yield* files.read("/workspace/moved/renamed")).bytes).toEqual(bytes("abcdef"))
      yield* files.move("/workspace/empty", "/workspace/moved")
      expect((yield* files.stat("/workspace/moved/empty/nested")).type).toBe("directory")
      yield* files.remove("/workspace/moved")
      yield* files.remove("/workspace/absent")
      expect(yield* files.list("/workspace")).toEqual([])
    }),
  )

  integration(
    "returns contract error kinds and never accesses sibling prefixes",
    Effect.gen(function* () {
      const config = options()
      const files = yield* Effect.acquireRelease(
        Effect.sync(() => S3Files.make(config)),
        (files) => files.remove("/workspace").pipe(Effect.orDie),
      )
      const sibling = yield* Effect.acquireRelease(
        Effect.sync(() => S3Files.make({ ...config, prefix: `${config.prefix}-sibling` })),
        (files) => files.remove("/workspace").pipe(Effect.orDie),
      )
      yield* sibling.write("/workspace/keep", bytes("safe"))
      yield* files.write("/workspace/file", bytes("x"))
      yield* files.mkdir("/workspace/dir")
      const cases = [
        [files.stat("/workspace/missing"), "Environment.NotFound"],
        [files.read("/workspace/missing"), "Environment.NotFound"],
        [files.list("/workspace/missing"), "Environment.NotFound"],
        [files.move("/workspace/missing", "/workspace/new"), "Environment.NotFound"],
        [files.read("/workspace/dir"), "Environment.WrongKind"],
        [files.list("/workspace/file"), "Environment.WrongKind"],
        [files.walk("/workspace/file"), "Environment.WrongKind"],
        [files.write("/workspace/dir", bytes("x")), "Environment.Failed"],
        [files.mkdir("/workspace/file/child"), "Environment.Failed"],
        [files.move("/workspace/dir", "/workspace/dir/sub"), "Environment.Failed"],
        [files.read("/workspace/file", { offset: -1, length: 1 }), "Environment.Failed"],
      ] as const
      for (const [operation, tag] of cases) {
        const result = yield* Effect.result(operation)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure._tag).toBe(tag)
      }
      yield* files.remove("/workspace")
      expect((yield* sibling.read("/workspace/keep")).bytes).toEqual(bytes("safe"))
    }),
  )

  integration(
    "paginates recursive walks, lists, moves and deletes beyond 1000 objects",
    Effect.gen(function* () {
      const config = options()
      const files = yield* Effect.acquireRelease(
        Effect.sync(() => S3Files.make(config)),
        (files) => files.remove("/workspace").pipe(Effect.orDie),
      )
      const s3 = new S3mini({
        ...config,
        fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => fetch(input, init), {
          preconnect: fetch.preconnect,
        }),
      })
      yield* Effect.forEach(
        Array.from({ length: 1005 }, (_, index) => index),
        (index) =>
          Effect.tryPromise(() => s3.putObject(`${config.prefix}/many/${String(index).padStart(4, "0")}`, "x")),
        { concurrency: 16 },
      )
      expect((yield* files.walk("/workspace")).length).toBe(1005)
      expect((yield* files.list("/workspace/many")).length).toBe(1005)
      yield* files.move("/workspace/many", "/workspace/renamed")
      expect((yield* files.walk("/workspace/renamed")).length).toBe(1005)
      const source = yield* Effect.result(files.stat("/workspace/many"))
      expect(source._tag).toBe("Failure")
      if (source._tag === "Failure") expect(source.failure._tag).toBe("Environment.NotFound")
      yield* files.remove("/workspace/renamed")
      expect(yield* files.list("/workspace")).toEqual([])
    }),
    120_000,
  ) // Real S3 writes, copies and deletes more than 1000 objects over HTTP.
})
