# S3 fork container delivery

This is fork packaging, not an upstream release or a production deployment.
No registry push, tag creation, release, or cluster write happens in CI.

## Candidate build

After review, the parent commits and pushes `opencode-prod` to `cwahn/opencode`.
Both `build-opencode-prod` and `check-hermetic` run on that branch. If a rerun is
needed, dispatch each workflow with `--ref opencode-prod`; do not run the broad
upstream release workflow or change the repository default branch.

```sh
gh workflow run build-opencode-prod.yml --repo cwahn/opencode --ref opencode-prod
gh workflow run check-hermetic.yml --repo cwahn/opencode --ref opencode-prod
gh run list --repo cwahn/opencode --branch opencode-prod
```

The build uses Bun **1.4.4**, `bun install --frozen-lockfile` including musl native
dependencies, then the unchanged upstream `script/build.ts --skip-install` with
`OPENCODE_TARGET=linux-x64-baseline-musl`. It builds the full CLI, including its
upstream embedded app assets. Its version is `2.2.1-s3.<12-source-hex>`.

The only Dockerfile delta is replacing floating `alpine` with the observed
`alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a`.
This is the multi-platform index served for upstream's `alpine:latest` when
packaging was authored. Its AMD64 manifest is
`sha256:c26612752c78b18faacd63c7d50f4592c2e7b0f25e0e20e82bd74e465c57ab0d`;
ARM64 is `sha256:e311ae748be7f56ae5cba304bc488f0786df68ee507513f654a5cc8597cffb42`.
Pinning prevents a silent base change; BuildKit provenance and the runtime APK
inventory record the actual result (APK repositories themselves are not frozen).
No extra probe tools, wrapper entrypoint, or replacement executable are added.
The upstream libgcc/libstdc++/ripgrep install and `ENTRYPOINT ["opencode"]` remain.

ARM64 packaging is retained: compile with upstream target `linux-arm64-musl`,
then build with `--platform linux/arm64` on an ARM64 runner (or separately approved
emulation). Its existing Dockerfile stage remains intact. This AMD64 production
workflow intentionally does not force an ARM64 build or smoke test.

CI builds **once**, retaining the full BuildKit max-provenance OCI archive. The
normalizer verifies every referenced blob's digest/size and the in-toto
provenance subject's binding to the sole Linux AMD64 image, then exports a
single-production-manifest archive without changing any manifest/config/layer
bytes. It imports that production archive into Docker using Skopeo and tests
the imported image. The imported executable checksum must equal the
fork-compiled binary. The successful candidate artifact is named
`opencode-s3-linux-amd64-<full-source-SHA>` and contains:

- `opencode-s3-linux-amd64.oci.tar` (OCI image layout/archive, not Docker save)
- `buildkit-max.oci.tar` (original full attestation graph, never discarded)
- `SHA256SUMS`, covering the archive and all evidence files
- `provenance.json`: importer-compatible exact source/baseline SHA, platform/compiler target, Bun,
  base identity, binary/lock/Dockerfile/archive SHA-256, CI attempt URL and tools
- `build-metadata.json`: BuildKit max provenance, including resolved materials
- `oci-evidence.json`: production manifest digest, original BuildKit archive/index
  checksums, verified provenance subject and attestation manifest digests
- `image-inspect.json`, `runtime-inventory.txt`, `smoke-results.json`

The deployment archive's `index.json` has exactly one descriptor of media type
`application/vnd.oci.image.manifest.v1+json`; `imageDigest` locks that descriptor,
not the root index or an attestation manifest. Its value is identical to the
verified BuildKit in-toto subject. `provenance.json` uses the downstream lock's
field names: `sourceRepository`, `sourceRevision`, `platform`, `archiveSha256`,
`imageDigest`, `binarySha256`, `dependencyLockSha256`, `baseImageDigest`, `ciRunUrl`.
`baseImageDigest` is the pinned multi-platform Alpine index digest; BuildKit
evidence also retains the resolved platform-specific material. `ciRunUrl` is
the run URL without `/attempts/...`; `ciRunAttempt` records the attempt separately.
`packagedImageTestsPassed` starts false and is only changed to true by the
workflow's post-success step, after verifying the smoke evidence's source SHA.
All archive/evidence checksums are generated afresh after this finalization.

This Actions artifact expires after 30 days. It is **not** a durable production
dependency. Download it promptly for the separately gated release below.

## Container acceptance and probes

`script/container-smoke.ts` requires Linux Docker and preprovisioned pinned
MinIO. The existing setup-minio action verifies the MinIO Go module sums before
building it. MinIO is loopback-only; the disposable CI containers use Linux host
networking to reach it. There is no external S3 or provider fallback.

The smoke runs UID/GID 65534, read-only root, all capabilities dropped,
no-new-privileges, a writable `/state` bind and `/tmp` tmpfs. CI's disposable
world-writable host state directory is not a production PVC ownership policy.
Production must supply writable PVC ownership/fsGroup. No image USER change is
made: the deployment must explicitly set non-root security contexts.

Acceptance covers compiled version, packaged `rg`, password 401/success, actual
MinIO upload/get and HTTP read/list/range/write, session creation at `/workspace`,
real uploaded PNG/text attachment admission with byte equality, host/missing/
outside-prefix attachment rejection, no host-file fallback, writable paths,
effective database `/state/data/opencode.db.s3-<workspace-identity>`, secret-free startup logs, and
graceful SIGTERM (exit 0, not SIGKILL). It does not execute a model or assert
provider availability. Source-level hermetic tests remain a separate gate.
The configured `OPENCODE_DB=/state/data/opencode.db` is a base path, not the
effective S3-profile filename. The server appends the full workspace identity
from `S3Workspace.identity(endpoint, bucket, prefix)`; the smoke uses that actual
upstream function and asserts the resulting file exists and has nonzero size.
`smoke-results.json` records the effective path for the disposable CI identity.

The following exact commands are exercised **inside the final image**. They use
BusyBox `sh`, `wget`, `printf`, `base64`, `tr`, `grep` and `kill`; not curl, jq, or
a standalone Bun executable. Set `PORT=4096` in the deployment. Inject
`OPENCODE_PASSWORD` from a Secret; never embed its value in a manifest or URL.

Startup (authenticated local API; allow enough initial migration time):

```sh
wget -q -T 5 -O - --header "Authorization: Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64 | tr -d '\n')" "http://127.0.0.1:$PORT/api/info" >/dev/null
```

Readiness requires a storage-owned sentinel at `<prefix>/.health/ready` containing
`opencode-s3-ready-v1\n`. Provision it in the dedicated bucket before acceptance.
It proves the authenticated API can read the configured S3 backend; `/api/info`
alone does not. Use a Kubernetes probe timeout greater than wget's 5 seconds.

```sh
wget -q -T 5 -O - --header "Authorization: Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64 | tr -d '\n')" "http://127.0.0.1:$PORT/api/fs/read/.health/ready" | grep -qx opencode-s3-ready-v1
```

Liveness is deliberately local/process-oriented and does not depend on S3 or a
model provider, so their outage removes readiness without inducing restart loops:

```sh
kill -0 1
```

Explicit empty and partial S3 variables fail before listening. **All S3 variables
absent intentionally selects upstream local mode**; packaging does not redesign
that runtime contract. The smoke rejects that mode with the S3 readiness check;
the chart must require complete S3 configuration. A fully specified unreachable
backend may still serve `/api/info`, but must fail the S3 readiness/acceptance
gate. Do not treat a TCP listener or an info response as S3 usability.

## Parent-owned durable release gate

Do not create a tag or release until the exact packaging SHA has passed both
workflows and every check on that SHA is clean. PR merge SHAs are not substitutes
for the branch SHA. If source changes, rebuild and repeat the gate; never reuse
an older archive under a newer source identity.

Example parent procedure, **only after review/commit/push and CI completion**:

```bash
set -euo pipefail
repo=cwahn/opencode
sha=$(git rev-parse HEAD)
gh run list --repo "$repo" --commit "$sha" --limit 100 \
  --json databaseId,workflowName,headSha,status,conclusion > runs.json
for workflow in build-opencode-prod check-hermetic; do
  jq -e --arg sha "$sha" --arg workflow "$workflow" '
    [.[] | select(.headSha == $sha and .workflowName == $workflow)]
    | sort_by(.databaseId) | last
    | .status == "completed" and .conclusion == "success"
  ' runs.json
done
gh api --paginate "repos/$repo/commits/$sha/check-runs?per_page=100" \
  --jq '.check_runs[] | {name,status,conclusion}' | jq -s -e '
    length > 0 and all(.status == "completed" and .conclusion == "success")'
run=$(jq -r '[.[] | select(.workflowName == "build-opencode-prod")] | sort_by(.databaseId) | last.databaseId' runs.json)
gh run download "$run" --repo "$repo" --name "opencode-s3-linux-amd64-$sha" --dir candidate
(cd candidate && sha256sum --check SHA256SUMS)
jq -e --arg sha "$sha" '.sourceRevision == $sha and .platform == "linux/amd64" and .packagedImageTestsPassed == true' candidate/provenance.json
jq -e --arg sha "$sha" '.revision == $sha' candidate/smoke-results.json
# gh release create fails if the release already exists; NEVER use upload --clobber.
# A full SHA makes the tag immutable-by-policy and unambiguous for downstream Buck.
tag="opencode-s3-2.2.1-$sha"
if gh api "repos/$repo/git/ref/tags/$tag" >/dev/null 2>&1; then
  echo "Refusing to reuse an existing tag" >&2
  exit 1
fi
gh release create "$tag" candidate/* --repo "$repo" --target "$sha" \
  --title "OpenCode S3 2.2.1 ($sha)" --latest=false \
  --notes "Validated fork OCI archive. Source $sha; packaging CI run $run. See provenance and SHA256SUMS. Do not overwrite assets."
```

The parent records the durable release URL, full SHA, OCI archive SHA-256 and CI
URLs for the downstream artifact lock. Never lock a branch URL or transient
Actions download URL. Publication to the production registry is outside this
application packaging workflow.
