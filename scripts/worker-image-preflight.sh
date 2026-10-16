#!/bin/sh
# Read-only: validate an already pulled image; never start, stop, pull or build.
set -eu
image=${1:?Usage: worker-image-preflight.sh IMAGE_DIGEST APPROVED_COMMIT}
revision=${2:?Usage: worker-image-preflight.sh IMAGE_DIGEST APPROVED_COMMIT}
if ! printf '%s\n' "$image" | LC_ALL=C grep -Eq '^(ghcr\.io/[a-z0-9._/-]+@)?sha256:[0-9a-f]{64}$'; then
  echo 'Expected a GHCR digest or immutable local sha256 image ID' >&2; exit 1
fi
if ! printf '%s\n' "$revision" | LC_ALL=C grep -Eq '^[0-9a-f]{40}$'; then
  echo 'Expected a full approved Git commit SHA' >&2; exit 1
fi
checkout=$(git rev-parse HEAD)
if [ "$checkout" != "$revision" ]; then
  echo 'Checkout does not match the approved commit' >&2; exit 1
fi
actual=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
if [ "$actual" != "$revision" ] || [ "$platform" != 'linux/amd64' ]; then
  echo 'Image revision or platform does not match the approved AMD server build' >&2; exit 1
fi
printf 'Verified worker image: %s\nSource: %s\nPlatform: %s\n' "$image" "$actual" "$platform"
