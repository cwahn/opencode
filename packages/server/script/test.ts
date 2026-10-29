import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { isolatedTestEnv } from "../../core/test/fixture/test-environment"

// Use `bun run test [filters/flags]`, not `bun test`: isolation must precede all imports.
await using directory = await tmpdir("opencode-server-test-")
await fs.mkdir(path.join(directory.path, "tmp"))
const child = Bun.spawn({
  cmd: [process.execPath, "test", "--only-failures", ...process.argv.slice(2)],
  env: {
    ...isolatedTestEnv(directory.path),
    // Also preload the guard in Bun children, not just the test runner.
    BUN_OPTIONS: `--preload=${path.join(import.meta.dir, "../test/fixture/network.ts")}`,
    OPENCODE_TEST_NETWORK_VIOLATIONS: path.join(directory.path, "network-violations"),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const interrupt = () => child.kill("SIGINT")
const terminate = () => child.kill("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)
try {
  process.exitCode = await child.exited
  const violations = Bun.file(path.join(directory.path, "network-violations"))
  if (await violations.exists()) {
    console.error(await violations.text())
    process.exitCode = 1
  }
} finally {
  process.off("SIGINT", interrupt)
  process.off("SIGTERM", terminate)
}
