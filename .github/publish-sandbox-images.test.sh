#!/bin/bash
set -euo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/.github/bin"
cp .github/publish-sandbox-images.sh "$ROOT/.github/publish-sandbox-images.sh"
cp .github/load-docker-images.sh "$ROOT/.github/load-docker-images.sh"

cat > "$ROOT/.github/crane-copy-retry.sh" <<'SCRIPT'
#!/bin/bash
crane_copy_retry() {
  printf '%s -> %s\n' "$1" "$2" >> "$CRANE_COPY_LOG"
}
SCRIPT

cat > "$ROOT/docker-images.txt" <<'IMAGES'
sandbox
sandbox-python
sandbox-opencode
sandbox-musl
sandbox-standalone
IMAGES

export CLOUDFLARE_ACCOUNT_ID=test-account
export CRANE_COPY_LOG="$ROOT/copies.log"
: > "$CRANE_COPY_LOG"

(
  cd "$ROOT"
  .github/publish-sandbox-images.sh \
    --source-tag prerelease-next-0.13.0-next.1.1 \
    --version 0.13.0-next.1.1 \
    --alias next \
    --docker-hub \
    --cf-library
)

cat > "$ROOT/expected.log" <<'EXPECTED'
registry.cloudflare.com/test-account/sandbox:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:0.13.0-next.1.1
registry.cloudflare.com/test-account/sandbox:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:next
registry.cloudflare.com/test-account/sandbox-python:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:0.13.0-next.1.1-python
registry.cloudflare.com/test-account/sandbox-python:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:next-python
registry.cloudflare.com/test-account/sandbox-opencode:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:0.13.0-next.1.1-opencode
registry.cloudflare.com/test-account/sandbox-opencode:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:next-opencode
registry.cloudflare.com/test-account/sandbox-musl:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:0.13.0-next.1.1-musl
registry.cloudflare.com/test-account/sandbox-musl:prerelease-next-0.13.0-next.1.1 -> docker.io/cloudflare/sandbox:next-musl
registry.cloudflare.com/test-account/sandbox:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:0.13.0-next.1.1
registry.cloudflare.com/test-account/sandbox:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:next
registry.cloudflare.com/test-account/sandbox-python:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:0.13.0-next.1.1-python
registry.cloudflare.com/test-account/sandbox-python:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:next-python
registry.cloudflare.com/test-account/sandbox-opencode:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:0.13.0-next.1.1-opencode
registry.cloudflare.com/test-account/sandbox-opencode:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:next-opencode
registry.cloudflare.com/test-account/sandbox-musl:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:0.13.0-next.1.1-musl
registry.cloudflare.com/test-account/sandbox-musl:prerelease-next-0.13.0-next.1.1 -> registry.cloudflare.com/library/sandbox:next-musl
EXPECTED

diff -u "$ROOT/expected.log" "$CRANE_COPY_LOG"
