import path from "node:path"

export function isolatedTestEnv(
  root: string,
  source = process.env,
  record = false,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([name]) => {
        // Explicit fixture knobs (including the pinned MinIO binary) are not production configuration.
        if (name.startsWith("OPENCODE_TEST_")) return true
        if (record && source.OPENCODE_TEST_REQUIRE_S3 !== "1" && name === "OPENAI_API_KEY") return true
        if (
          /^(?:OPENCODE|AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG|GIT)_/i.test(
            name,
          )
        )
          return false
        if (
          /^(?:BUN_OPTIONS|NODE_OPTIONS|BUN_RUNTIME_TRANSPILER_CACHE_PATH|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(
            name,
          )
        )
          return false
        return !/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)
      }),
    ),
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_DATA_HOME: path.join(root, ".local", "share"),
    XDG_CACHE_HOME: path.join(root, ".cache"),
    XDG_STATE_HOME: path.join(root, ".local", "state"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "transpiler"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    OPENCODE_TEST_HOME: root,
    OPENCODE_CONFIG_DIR: path.join(root, ".config", "opencode"),
  }
}
