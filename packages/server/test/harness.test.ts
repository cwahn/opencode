import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { isolatedTestEnv } from "../../core/test/fixture/test-environment"
import { tmpdir } from "../../core/test/fixture/tmpdir"

test("isolated environment removes ambient config and credentials, preserving explicit test inputs", () => {
  const env = isolatedTestEnv(
    "/isolated",
    {
      PATH: "/tools",
      OPENCODE_S3_ENDPOINT: "https://production.example",
      OPENCODE_CONFIG_CONTENT: "user config",
      OPENCODE_TEST_REQUIRE_S3: "1",
      OPENCODE_TEST_MINIO_BIN: "/tools/minio",
      OPENAI_API_KEY: "secret",
      AWS_PROFILE: "production",
      CUSTOM_TOKEN: "secret",
      GIT_CONFIG_GLOBAL: "/host/gitconfig",
      BUN_OPTIONS: "--preload=/host/plugin.ts",
      https_proxy: "https://proxy.example",
    },
    true,
  )
  expect(env.PATH).toBe("/tools")
  expect(env.OPENCODE_TEST_REQUIRE_S3).toBe("1")
  expect(env.OPENCODE_TEST_MINIO_BIN).toBe("/tools/minio")
  for (const name of [
    "OPENCODE_S3_ENDPOINT",
    "OPENCODE_CONFIG_CONTENT",
    "OPENAI_API_KEY",
    "AWS_PROFILE",
    "CUSTOM_TOKEN",
    "BUN_OPTIONS",
    "https_proxy",
  ]) {
    expect(env[name]).toBeUndefined()
  }
  expect(env.GIT_CONFIG_GLOBAL).toBe(path.join("/isolated", "gitconfig"))
})

test("runner isolates children, permits real loopback HTTP, fails swallowed egress and cleans both runs", async () => {
  await using directory = await tmpdir()
  const fixture = path.join(directory.path, "probe.test.ts")
  const report = path.join(directory.path, "report.json")
  await Bun.write(
    fixture,
    `
import { expect, test } from "bun:test"
test("probe", async () => {
  await Bun.write(process.env.OPENCODE_TEST_REPORT, JSON.stringify({ home: process.env.HOME, config: process.env.OPENCODE_CONFIG, token: process.env.OPENAI_API_KEY }))
  const child = Bun.spawn([process.execPath, "-e", "console.log(process.env.HOME)"], { stdout: "pipe" })
  expect((await new Response(child.stdout).text()).trim()).toBe(process.env.HOME)
  expect(await child.exited).toBe(0)
  expect(typeof fetch.preconnect).toBe("function")
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/redirect") return Response.redirect(new URL("/ok", request.url))
    if (new URL(request.url).pathname === "/external") return Response.redirect("https://network-forbidden.invalid")
    return new Response("real loopback")
  } })
  try {
    expect(await (await fetch(new URL("/redirect", server.url))).text()).toBe("real loopback")
    if (process.env.OPENCODE_TEST_DENY === "1") {
      await fetch(new URL("/external", server.url)).catch(() => {})
      const denied = Bun.spawn([process.execPath, "-e", 'try { fetch.preconnect("https://child-network-forbidden.invalid") } catch {}'], { stdout: "pipe", stderr: "pipe" })
      expect(await denied.exited).toBe(1)
    }
  } finally { server.stop(true) }
})

`,
  )
  for (const deny of ["0", "1"]) {
    const child = Bun.spawn([process.execPath, "run", "script/test.ts", fixture], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_CONFIG: "/host/config.json",
        OPENAI_API_KEY: "must-not-escape",
        OPENCODE_TEST_REPORT: report,
        OPENCODE_TEST_DENY: deny,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr + stdout).toContain("1 pass")
    expect(code).toBe(deny === "1" ? 1 : 0)
    if (deny === "1") expect(stderr).toContain("test attempted external network request")
    const result = await Bun.file(report).json()
    expect(result.config).toBeUndefined()
    expect(result.token).toBeUndefined()
    expect(result.home).not.toBe(process.env.HOME)
    expect(await fs.stat(result.home).catch(() => undefined)).toBeUndefined()
  }
})

test("optional S3 origin is narrowly allowed, cannot redirect away, and is denied in required mode", async () => {
  await using directory = await tmpdir()
  // IPv4-mapped IPv6 reaches this real local listener without requiring a loopback alias
  // (127.0.0.2 is not reachable by default on macOS), but is outside the guard's allowlist.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/same") return Response.redirect(new URL("/ok", url))
      if (url.pathname === "/escape") return Response.redirect(`http://127.0.0.1:${url.port}/ok`)
      return new Response("real S3 endpoint")
    },
  })
  try {
    for (const [required, route, denied] of [
      ["0", "/same", false],
      ["0", "/escape", true],
      ["1", "/ok", true],
    ] as const) {
      const journal = path.join(directory.path, `${required}-${route.slice(1)}`)
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        const response = await fetch(process.env.OPENCODE_TEST_S3_ENDPOINT + ${JSON.stringify(route)}, { signal: AbortSignal.timeout(2000) }).catch(() => undefined)
        if (response) console.log(await response.text())
      `,
        ],
        {
          env: {
            ...process.env,
            OPENCODE_TEST_REQUIRE_S3: required,
            OPENCODE_TEST_S3_ENDPOINT: `http://[::ffff:127.0.0.1]:${server.port}`,
            OPENCODE_TEST_NETWORK_VIOLATIONS: journal,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr.includes("test attempted external network request")).toBe(denied)
      expect(code).toBe(denied ? 1 : 0)
      expect(stdout.trim()).toBe(denied ? "" : "real S3 endpoint")
      expect(await Bun.file(journal).exists()).toBe(denied)
    }
  } finally {
    server.stop(true)
  }
})
