import { appendFileSync } from "node:fs"

// Test-only HTTP boundary. No response mocks: loopback requests use Bun's real fetch.
// This is not an OS sandbox for arbitrary executables or raw sockets.
const original = globalThis.fetch
const violations: string[] = []
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])
// Optional interoperability tests may contact exactly their explicitly selected S3 origin.
const endpoint =
  process.env.OPENCODE_TEST_REQUIRE_S3 !== "1" && process.env.OPENCODE_TEST_S3_ENDPOINT
    ? new URL(process.env.OPENCODE_TEST_S3_ENDPOINT).origin
    : undefined

function check(url: string | URL, redirectOrigin?: string) {
  const parsed = new URL(url)
  if (
    (!redirectOrigin || parsed.origin === redirectOrigin) &&
    (loopback.has(parsed.hostname) || parsed.origin === endpoint)
  )
    return
  const message = `test attempted external network request: ${url}`
  violations.push(message)
  // Bun's test runner overwrites exitCode; the owning harness checks this journal after exit.
  if (process.env.OPENCODE_TEST_NETWORK_VIOLATIONS) {
    appendFileSync(process.env.OPENCODE_TEST_NETWORK_VIOLATIONS, message + "\n")
  }
  throw new Error(message)
}

async function guarded(input: string | URL | Request, init?: RequestInit, redirects = 0): Promise<Response> {
  const request = new Request(input, init)
  check(request.url)
  // Inspect redirects before following: a local endpoint must not escape the boundary.
  const response = await original(request.clone(), {
    ...init,
    redirect: request.redirect === "follow" ? "manual" : request.redirect,
  })
  if (request.redirect !== "follow" || ![301, 302, 303, 307, 308].includes(response.status)) return response
  const location = response.headers.get("location")
  if (!location) return response
  const next = new URL(location, request.url)
  check(next, new URL(request.url).origin === endpoint ? endpoint : undefined)
  await response.body?.cancel()
  if (redirects === 20) throw new TypeError("Too many redirects")
  const get =
    (response.status === 303 && request.method !== "HEAD") ||
    ([301, 302].includes(response.status) && request.method === "POST")
  const headers = new Headers(request.headers)
  if (next.origin !== new URL(request.url).origin) {
    headers.delete("authorization")
    headers.delete("cookie")
  }
  if (get) {
    headers.delete("content-length")
    headers.delete("content-type")
  }
  return guarded(
    next,
    {
      ...init,
      method: get ? "GET" : request.method,
      headers,
      body: get || ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      signal: request.signal,
    },
    redirects + 1,
  )
}

globalThis.fetch = Object.assign(guarded, {
  preconnect: (...args: Parameters<typeof fetch.preconnect>) => {
    check(args[0])
    original.preconnect(...args)
  },
})

// Production startup sometimes catches fetch errors. A denied attempt must still fail the run.
process.on("exit", () => {
  if (!violations.length) return
  console.error(violations.join("\n"))
  process.exitCode = 1
})
