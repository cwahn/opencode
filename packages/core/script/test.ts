import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../test/fixture/tmpdir"
import { isolatedTestEnv } from "../test/fixture/test-environment"

await using directory = await tmpdir("oc-")
const home = directory.path
const temporary = path.join(home, "tmp")
await fs.mkdir(temporary)

const environment = isolatedTestEnv(home, process.env, process.env.RECORD === "true")

const child = Bun.spawn({
  // The 30s default timeout matches cli and tui; npm.test's Git package installs ran past Bun's 5s default on Windows.
  cmd: [process.execPath, "test", "--only-failures", "--timeout=30000", ...process.argv.slice(2)],
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const interrupt = () => child.kill("SIGINT")
const terminate = () => child.kill("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)
const result = await child.exited
process.off("SIGINT", interrupt)
process.off("SIGTERM", terminate)

process.exitCode = result
