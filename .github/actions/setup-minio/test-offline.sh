#!/usr/bin/env bash
set -euo pipefail

# The workflow enters a fresh network namespace and drops privileges before this script.
test "$(id -u)" -ne 0
test "$(ip -o link show | awk -F': ' '{print $2}')" = lo
test -z "$(ip -4 route show)"
test -z "$(ip -6 route show default)"
ip address show dev lo
test "$OPENCODE_TEST_REQUIRE_S3" = 1
test -x "$OPENCODE_TEST_MINIO_BINARY"
command -v bun
command -v rg
bun --version
rg --version
"$OPENCODE_TEST_MINIO_BINARY" --version

results="$RUNNER_TEMP/hermetic-results"
mkdir -p "$results"
# A missing/renamed suite is a failure, not an accidentally empty green run.
shopt -s failglob
cd "$GITHUB_WORKSPACE/packages/core"
bun run test test/*s3*.test.ts test/oauth-callback*.test.ts \
  --reporter=junit --reporter-outfile="$results/core-s3-oauth.xml" 2>&1 | tee "$results/core-s3-oauth.log"

cd "$GITHUB_WORKSPACE/packages/server"
bun run test test/s3.test.ts test/s3-integration.test.ts \
  --reporter=junit --reporter-outfile="$results/server-s3.xml" 2>&1 | tee "$results/server-s3.log"

bun run test --reporter=junit --reporter-outfile="$results/server.xml" 2>&1 | tee "$results/server.log"

cd "$GITHUB_WORKSPACE/packages/core"
bun run test --reporter=junit --reporter-outfile="$results/core-full.xml" 2>&1 | tee "$results/core-full.log"
