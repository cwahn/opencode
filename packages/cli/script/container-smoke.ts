#!/usr/bin/env bun

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { S3Files } from "../../core/src/environment/s3"
import { S3Workspace } from "../../core/src/workspace/s3"
import { s3Fixture } from "../../core/test/fixture/s3"

// Linux Docker only: the private fixture binds loopback and containers use host networking.
assert.equal(process.platform, "linux", "Run container smoke in Linux CI, not local Docker")
const image = process.env.OPENCODE_CONTAINER_IMAGE
assert.ok(image, "OPENCODE_CONTAINER_IMAGE is required")
await using fixture = await s3Fixture()
const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-container-"))
const prefix = `container-${crypto.randomUUID()}`
const s3 = S3Files.make({ ...fixture, prefix })
const database = `/state/data/opencode.db.s3-${S3Workspace.identity({ ...fixture, prefix })}`
const password = crypto.randomUUID()
const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}` }
const containers: string[] = []
const evidence: string[] = []
const s3env = {
  OPENCODE_S3_ENDPOINT: fixture.endpoint,
  OPENCODE_S3_BUCKET: fixture.bucket,
  OPENCODE_S3_PREFIX: prefix,
  OPENCODE_S3_REGION: "us-east-1",
  OPENCODE_S3_ACCESS_KEY_ID: fixture.accessKeyId,
  OPENCODE_S3_SECRET_ACCESS_KEY: fixture.secretAccessKey,
}
const probe = `wget -q -T 5 -O - --header "Authorization: Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64 | tr -d '\\n')"`
const readyProbe = `${probe} http://127.0.0.1:$PORT/api/fs/read/.health/ready | grep -qx opencode-s3-ready-v1`

async function docker(args: string[], env: Record<string, string> = {}, allowFailure = false) {
  const child = Bun.spawn(["docker", ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // Never dump a Docker command/environment or server log containing credentials.
  if (!allowFailure) assert.equal(code, 0, `docker ${args[0]} failed: ${redact(stderr)}`)
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

function redact(text: string) {
  return [password, fixture.secretAccessKey, headers.authorization].reduce(
    (result, secret) => result.replaceAll(secret, "[REDACTED]"),
    text,
  )
}

async function start(settings: Record<string, string>) {
  const name = `opencode-smoke-${crypto.randomUUID()}`
  const state = path.join(root, name)
  await fs.mkdir(state, { mode: 0o777 })
  // Disposable CI fixture only. Production uses PVC ownership/fsGroup, not world-writable state.
  await fs.chmod(state, 0o777)
  const env = {
    HOME: "/state/home",
    XDG_CONFIG_HOME: "/state/config",
    XDG_DATA_HOME: "/state/data",
    XDG_STATE_HOME: "/state/state",
    XDG_CACHE_HOME: "/state/cache",
    OPENCODE_DB: "/state/data/opencode.db",
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    ...settings,
  }
  containers.push(name)
  await docker(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      "host",
      "--user",
      "65534:65534",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${state},dst=/state`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      ...Object.keys(env).flatMap((key) => ["--env", key]),
      image!,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    env,
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const logs = await docker(["logs", name])
    // Default serve announces the dynamically selected listener.
    const address = /http:\/\/127\.0\.0\.1:(\d+)/.exec(logs.stdout)
    if (address) return { name, state, url: address[0], port: address[1] }
    const running = await docker(["inspect", "--format", "{{.State.Running}}", name])
    if (running.stdout === "false") return { name, state }
    await Bun.sleep(100)
  }
  throw new Error(`Container did not announce its listener within 60s (${name})`)
}

async function request(url: string, route: string, init: RequestInit = {}) {
  return fetch(`${url}${route}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(40_000),
  })
}

async function ready(server: Awaited<ReturnType<typeof start>>) {
  if (!server.url) return false
  return (
    (await docker(["exec", "--env", `PORT=${server.port}`, server.name, "sh", "-c", readyProbe], {}, true)).code === 0
  )
}

async function stop(name: string) {
  await docker(["stop", "--time", "20", name])
  const state = JSON.parse((await docker(["inspect", "--format", "{{json .State}}", name])).stdout)
  assert.equal(state.Running, false)
  assert.equal(state.OOMKilled, false)
  assert.equal(state.ExitCode, 0, "SIGTERM must gracefully exit, not time out/SIGKILL")
}

try {
  const version = await docker(["run", "--rm", image, "--version"])
  assert.equal(version.stdout, `opencode v2.2.1-s3.${process.env.GITHUB_SHA?.slice(0, 12)}`)
  const rg = await docker(["run", "--rm", "--entrypoint", "rg", image, "--version"])
  assert.match(rg.stdout, /^ripgrep /)
  evidence.push("compiled fork version and packaged ripgrep executable")

  await Effect.runPromise(s3.write("/workspace/.health/ready", Buffer.from("opencode-s3-ready-v1\n")))
  const text = "Container S3 input, never a local workspace file\nsecond line\n"
  // A real supported PNG attachment, not just a MIME label or arbitrary byte string.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  )
  await Effect.runPromise(s3.write("/workspace/input/notes.txt", Buffer.from(text)))
  await Effect.runPromise(s3.write("/workspace/input/pixel.png", png))
  const server = await start(s3env)
  assert.ok(server.url, "Complete S3 configuration must start")
  const url = server.url
  assert.equal((await fetch(`${url}/api/info`)).status, 401)
  assert.equal(
    (await fetch(`${url}/api/info`, { headers: { authorization: `Basic ${btoa("opencode:wrong")}` } })).status,
    401,
  )
  assert.equal((await request(url, "/api/info")).status, 200)
  await docker([
    "exec",
    "--env",
    `PORT=${server.port}`,
    server.name,
    "sh",
    "-c",
    `${probe} http://127.0.0.1:$PORT/api/info >/dev/null`,
  ])
  assert.equal(await ready(server), true, "Authenticated S3 readiness probe")
  assert.notEqual(
    (
      await docker(
        [
          "exec",
          "--env",
          `PORT=${server.port}`,
          "--env",
          "OPENCODE_PASSWORD=wrong",
          server.name,
          "sh",
          "-c",
          readyProbe,
        ],
        {},
        true,
      )
    ).code,
    0,
  )
  await docker([
    "exec",
    server.name,
    "sh",
    "-c",
    'kill -0 1; test "$(id -u)" = 65534; touch /state/writable /tmp/writable; test ! -w /usr/local/bin',
  ])
  assert.equal(
    (
      await docker(
        ["exec", server.name, "sh", "-c", "wget -q -T 5 -O /dev/null http://127.0.0.1:" + server.port + "/api/info"],
        {},
        true,
      )
    ).code === 0,
    false,
  )
  evidence.push(
    "non-root UID 65534, read-only root, dropped caps, no-new-privileges, writable /state and /tmp",
    "401 unauthenticated/wrong password; authenticated info and BusyBox wget probes",
  )

  const read = await request(url, "/api/fs/read/input/notes.txt")
  assert.equal(read.status, 200)
  assert.equal(await read.text(), text)
  const range = await request(url, "/api/fs/read/input/notes.txt", { headers: { Range: "bytes=2-8" } })
  assert.equal(range.status, 206)
  assert.equal(await range.text(), text.slice(2, 9))
  const list = await request(url, "/api/fs/list?path=input")
  assert.equal(list.status, 200)
  assert.deepEqual((await list.json()).data.map((entry: { path: string }) => entry.path).sort(), [
    "input/notes.txt",
    "input/pixel.png",
  ])
  const write = await request(url, "/api/experimental/fs/write?path=output/result.txt", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "written by packaged HTTP server",
  })
  assert.equal(write.status, 200)
  assert.equal(
    Buffer.from((await Effect.runPromise(s3.read("/workspace/output/result.txt"))).bytes).toString(),
    "written by packaged HTTP server",
  )
  evidence.push("real MinIO upload, HTTP read/list/range/write, independent S3 get of HTTP output")

  const create = await request(url, "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  assert.equal(create.status, 200)
  const session = (await create.json()).data
  assert.equal(session.location.directory, "/workspace")
  const prompt = (uris: string[]) =>
    request(url, `/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Inspect uploaded inputs", files: uris.map((uri) => ({ uri })), resume: false }),
    })
  const admitted = await prompt([
    `s3://${fixture.bucket}/${prefix}/input/notes.txt`,
    `s3://${fixture.bucket}/${prefix}/input/pixel.png`,
  ])
  assert.equal(admitted.status, 200)
  const attachments = (await admitted.json()).data.payload.files
  assert.equal(attachments[0].data, Buffer.from(text).toString("base64"))
  assert.equal(attachments[1].mime, "image/png")
  assert.equal(attachments[1].data, png.toString("base64"))
  for (const uri of [
    "file:///etc/hosts",
    `s3://${fixture.bucket}/outside/secret.txt`,
    `s3://${fixture.bucket}/${prefix}/missing.txt`,
  ]) {
    assert.equal((await prompt([uri])).status, 400)
  }
  // The local file really exists in the tested container, but is absent from S3.
  await docker(["exec", server.name, "sh", "-c", "printf host-only > /tmp/host-only.txt"])
  assert.equal((await request(url, "/api/fs/read/tmp/host-only.txt")).status, 404)
  assert.equal((await request(url, "/api/fs/read/etc/hosts")).status, 404)
  const logs = await docker(["logs", server.name])
  assert.ok(!logs.stdout.includes(password), "Server must not print password")
  assert.ok(!logs.stderr.includes(password), "Server must not print password on stderr")
  // Inspect the database as the runtime UID; its private files must not be
  // readable by the host runner merely to satisfy this fixture assertion.
  assert.equal(
    (
      await docker([
        "exec",
        server.name,
        "sh",
        "-c",
        'test -s "$1" && od -An -tx1 -N16 "$1" | tr -d " \\n"',
        "sqlite-header",
        database,
      ])
    ).stdout,
    "53514c69746520666f726d6174203300",
  )
  await stop(server.name)
  evidence.push(
    "omitted session location resolves /workspace; uploaded text/PNG admission matches bytes; missing/outside-prefix/host attachments rejected",
    "no host-file fallback; S3-profile identity-namespaced database persisted; graceful SIGTERM exit 0; no password in startup stdout/stderr",
  )

  // Every explicit empty or partial S3 configuration must exit before listening.
  for (const missing of ["ENDPOINT", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) {
    const settings = { ...s3env }
    delete settings[`OPENCODE_S3_${missing}` as keyof typeof settings]
    const invalid = await start(settings)
    assert.equal(invalid.url, undefined)
    assert.notEqual((await docker(["inspect", "--format", "{{.State.ExitCode}}", invalid.name])).stdout, "0")
  }
  const empty = await start(Object.fromEntries(Object.keys(s3env).map((key) => [key, ""])))
  assert.equal(empty.url, undefined)
  evidence.push("explicit empty and incomplete S3 settings fail before listener startup")

  // Absence of ALL S3 variables intentionally retains upstream's local profile.
  // It is not a valid deployment configuration and MUST NOT pass S3 readiness.
  const local = await start({})
  assert.equal(await ready(local), false)
  if (local.url) await stop(local.name)
  evidence.push(
    "all S3 variables absent retains upstream local mode, rejected by S3 readiness (chart must require configuration)",
  )

  const unreachable = await start({ ...s3env, OPENCODE_S3_ENDPOINT: `http://127.0.0.1:1/${fixture.bucket}` })
  assert.equal(await ready(unreachable), false, "Info alone must never accept an unreachable backend")
  if (unreachable.url) {
    assert.equal((await request(unreachable.url, "/api/info")).status, 200)
    const result = await request(unreachable.url, "/api/fs/read/input/notes.txt")
    assert.ok(result.status >= 400)
    await stop(unreachable.name)
  }
  evidence.push(
    "fully configured unreachable backend cannot pass authenticated S3 sentinel readiness even when /api/info returns 200",
  )
  await Bun.write(
    path.join(import.meta.dir, "../dist/container/smoke-results.json"),
    JSON.stringify(
      {
        revision: process.env.GITHUB_SHA,
        evidence,
        probes: {
          startup: `${probe} http://127.0.0.1:$PORT/api/info >/dev/null`,
          readiness: readyProbe,
          liveness: "kill -0 1",
        },
        database,
      },
      null,
      2,
    ) + "\n",
  )
  console.log(evidence.join("\n"))
} finally {
  await Promise.allSettled(containers.map((name) => docker(["rm", "--force", name], {}, true)))
  // The non-root container UID owns nested PVC-fixture directories. Restore the
  // runner's ownership before deleting only this script's private temp tree.
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "0:0",
    "--mount",
    `type=bind,src=${root},dst=/fixture`,
    "--entrypoint",
    "chown",
    image,
    "-R",
    `${process.getuid!()}:${process.getgid!()}`,
    "/fixture",
  ])
  await fs.rm(root, { recursive: true, force: true })
}
