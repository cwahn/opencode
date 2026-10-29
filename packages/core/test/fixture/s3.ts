import { S3mini } from "s3mini"
import type { Options } from "../../src/environment/s3.js"
import { tmpdir } from "./tmpdir.js"

export type S3Fixture = Options & AsyncDisposable

/** Explicit paths are considered available so invalid opt-ins fail setup rather than silently skip. */
export const hasS3Fixture = () =>
  Boolean(process.env.OPENCODE_TEST_MINIO_BINARY || process.env.MINIO_BINARY || Bun.which("minio"))

/** A private, loopback-only S3 bucket. Install MinIO separately; tests never download binaries. */
export async function s3Fixture(): Promise<S3Fixture> {
  const requested = process.env.OPENCODE_TEST_MINIO_BINARY ?? process.env.MINIO_BINARY ?? "minio"
  const binary = Bun.which(requested)
  if (!binary) {
    throw new Error(
      `MinIO binary not found: ${requested}. Install minio on PATH or set OPENCODE_TEST_MINIO_BINARY to an executable MinIO binary.`,
    )
  }
  const directory = await tmpdir("opencode-s3-")
  const accessKeyId = "opencode-test"
  const secretAccessKey = `opencode-${crypto.randomUUID()}`
  const child = Bun.spawn(
    [
      binary,
      "server",
      "--address",
      "127.0.0.1:0",
      "--console-address",
      "127.0.0.1:0",
      "--certs-dir",
      `${directory.path}/certs`,
      `${directory.path}/data`,
    ],
    {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MINIO_"))),
        MINIO_ROOT_USER: accessKeyId,
        MINIO_ROOT_PASSWORD: secretAccessKey,
        MINIO_BROWSER: "off",
        MINIO_UPDATE: "off",
        MINIO_CALLHOME_ENABLE: "off",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const ready = Promise.withResolvers<string>()
  const output = { text: "" }
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output.text = `${output.text}${decoder.decode(chunk, { stream: true })}`.slice(-65_536)
      const address = /\bAPI:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output.text)?.[1]
      if (address) ready.resolve(address)
    }
  }
  const pumps = [drain(child.stdout), drain(child.stderr)]
  const dispose = async () => {
    child.kill()
    await child.exited
    await Promise.allSettled(pumps)
    await directory[Symbol.asyncDispose]()
  }
  // Startup is event-driven, with one bounded deadline instead of sleeping or polling a guessed port.
  const signal = AbortSignal.timeout(30_000)
  const timeout = () => ready.reject(new Error(`MinIO did not announce its loopback API within 30s:\n${output.text}`))
  signal.addEventListener("abort", timeout, { once: true })
  void child.exited.then((code) => ready.reject(new Error(`MinIO exited during startup (${code}):\n${output.text}`)))
  try {
    const origin = await ready.promise
    const bucket = `opencode-test-${crypto.randomUUID()}`
    const options = { endpoint: `${origin}/${bucket}`, bucket, accessKeyId, secretAccessKey, region: "us-east-1" }
    const s3 = new S3mini({
      ...options,
      requestAbortTimeout: 30_000,
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => fetch(input, init), {
        preconnect: fetch.preconnect,
      }),
    })
    if (!(await s3.createBucket())) throw new Error("MinIO refused the disposable test bucket")
    return { ...options, [Symbol.asyncDispose]: dispose }
  } catch (error) {
    await dispose()
    throw error
  } finally {
    signal.removeEventListener("abort", timeout)
  }
}
