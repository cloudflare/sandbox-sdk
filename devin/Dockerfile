FROM debian:bookworm-slim AS devin-cli

ARG DEVIN_CLI_TARGET=x86_64-unknown-linux
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Install the Devin CLI. `devin worker start` claims a session, downloads the
# matching devin-remote binary for that session, and runs it.
RUN set -eux; \
    MANIFEST="$(curl -fsSL https://static.devin.ai/cli/current/manifest.json)"; \
    PLATFORM="$(echo "$MANIFEST" | grep -o "\"$DEVIN_CLI_TARGET\"[[:space:]]*:[[:space:]]*{[^}]*}")"; \
    URL="$(echo "$PLATFORM" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"; \
    SHA="$(echo "$PLATFORM" | grep -o '"sha256"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"; \
    curl -fL "$URL" -o /tmp/devin-cli.tar.gz; \
    echo "$SHA  /tmp/devin-cli.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/devin-cli-extract; \
    tar xzf /tmp/devin-cli.tar.gz -C /tmp/devin-cli-extract; \
    mv /tmp/devin-cli-extract/bin/devin /usr/local/bin/devin; \
    chmod +x /usr/local/bin/devin

FROM debian:bookworm-slim

# Documented Devin Outposts machine dependencies:
# - git for repository operations
# - Chromium for browser/computer-use
# - ffmpeg for screen recording
# - passwordless sudo for session-time commands that invoke sudo
# ca-certificates is needed by the Devin CLI/runtime HTTPS clients.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git sudo chromium ffmpeg zstd \
  && echo 'root ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-devin-root \
  && chmod 0440 /etc/sudoers.d/90-devin-root \
  && rm -rf /var/lib/apt/lists/*

COPY --from=devin-cli /usr/local/bin/devin /usr/local/bin/devin
COPY bin/start-devin-worker /usr/local/bin/start-devin-worker
COPY bin/devin-checkpoint /usr/local/bin/devin-checkpoint
RUN chmod +x /usr/local/bin/start-devin-worker /usr/local/bin/devin-checkpoint \
  && devin --version

WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start-devin-worker"]
