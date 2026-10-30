#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root. Never builds or publishes a stock upstream CLI.
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
out=packages/cli/dist/container
mkdir -p "$out"
binary=packages/cli/dist/cli-linux-x64-baseline-musl/bin/opencode
base=$(sed -n 's/^FROM \([^ ]*\) AS base$/\1/p' packages/cli/Dockerfile)
[[ "$base" == *@sha256:* ]]
# The hosted runner's default docker driver may not support OCI archive export.
docker buildx create --driver docker-container --use \
  --name "opencode-s3-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
docker buildx inspect --bootstrap
# BuildKit derives in-toto subjects from exporter image names. An unnamed OCI
# export can have a valid attestation manifest but an empty statement subject.
# This is a local export name only; there is no registry push.
docker buildx build --platform linux/amd64 --provenance=mode=max --tag opencode-s3:ci \
  --label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY" \
  --label "org.opencontainers.image.revision=$GITHUB_SHA" \
  --label "org.opencontainers.image.base.name=$base" \
  --metadata-file "$out/build-metadata.json" \
  --output "type=oci,dest=$out/buildkit-max.oci.tar" \
  --file packages/cli/Dockerfile packages/cli

python3 packages/cli/script/container-oci.py "$out/buildkit-max.oci.tar" \
  "$out/opencode-s3-linux-amd64.oci.tar" "$out/oci-evidence.json"

# Convert only the transport for Docker; smoke checks the binary hash after import.
skopeo copy --override-os linux --override-arch amd64 \
  "oci-archive:$out/opencode-s3-linux-amd64.oci.tar" docker-daemon:opencode-s3:ci
test "$(docker image inspect --format '{{.Id}}' opencode-s3:ci)" = "$(jq -r .imageConfigDigest "$out/oci-evidence.json")"
docker run --rm --entrypoint /bin/sh opencode-s3:ci -c \
  'sha256sum /usr/local/bin/opencode; apk info -v | sort' > "$out/runtime-inventory.txt"
test "$(head -1 "$out/runtime-inventory.txt" | cut -d ' ' -f1)" = "$(sha256sum "$binary" | cut -d ' ' -f1)"
docker image inspect opencode-s3:ci > "$out/image-inspect.json"
jq -n \
  --arg source "https://github.com/$GITHUB_REPOSITORY" \
  --arg revision "$GITHUB_SHA" \
  --arg baseline a6039f05aefdf9c154c82778a068fdecf397c86a \
  --arg base "$base" \
  --arg binary "$(sha256sum "$binary" | cut -d ' ' -f1)" \
  --arg lock "$(sha256sum bun.lock | cut -d ' ' -f1)" \
  --arg dockerfile "$(sha256sum packages/cli/Dockerfile | cut -d ' ' -f1)" \
  --arg archive "$(sha256sum "$out/opencode-s3-linux-amd64.oci.tar" | cut -d ' ' -f1)" \
  --arg ci "https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --arg attempt "$GITHUB_RUN_ATTEMPT" \
  --arg bun "$(bun --version)" \
  --arg builder "$(docker buildx version)" \
  --arg transport "$(skopeo --version)" \
  --slurpfile oci "$out/oci-evidence.json" \
  '{schemaVersion:1,sourceRepository:$source,sourceRevision:$revision,baseline:$baseline,
    platform:"linux/amd64",compilerTarget:"linux-x64-baseline-musl",bun:$bun,
    baseImage:$base,baseImageDigest:($base|split("@")[1]),binarySha256:$binary,
    dependencyLockSha256:$lock,dockerfileSha256:$dockerfile,
    archiveSha256:$archive,imageDigest:$oci[0].imageDigest,
    buildkitArchiveSha256:$oci[0].buildkitArchiveSha256,
    verifiedProvenanceSubject:$oci[0].verifiedProvenanceSubject,
    ciRunUrl:$ci,ciRunAttempt:$attempt,builder:$builder,transport:$transport,
    packagedImageTestsPassed:false}' > "$out/provenance.json"
