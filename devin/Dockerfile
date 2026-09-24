FROM debian:bookworm-slim AS devin-cli

ARG DEVIN_CLI_TARGET=x86_64-unknown-linux
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Install the current Devin CLI and check it against the manifest's SHA-256.
RUN set -eux; \
    MANIFEST="$(curl -fsSL https://static.devin.ai/cli/current/manifest.json)"; \
    PLATFORM="$(echo "$MANIFEST" | grep -o "\"$DEVIN_CLI_TARGET\"[[:space:]]*:[[:space:]]*{[^}]*}")"; \
    URL="$(echo "$PLATFORM" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"; \
    SHA="$(echo "$PLATFORM" | grep -o '"sha256"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"; \
    curl -fL "$URL" -o /tmp/devin-cli.tar.gz; \
    echo "$SHA  /tmp/devin-cli.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/devin-cli; \
    tar xzf /tmp/devin-cli.tar.gz -C /tmp/devin-cli; \
    install -m 0755 /tmp/devin-cli/bin/devin /usr/local/bin/devin

FROM debian:bookworm-slim

# Devin Outposts machine dependencies: git for repositories, Chromium for
# browser use, ffmpeg for screen recording, and passwordless sudo for
# commands that invoke it. The rest is common tooling Devin expects.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git sudo chromium ffmpeg \
    build-essential python3 python3-pip awscli zip unzip wget ripgrep jq socat \
  && echo 'root ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-devin-root \
  && chmod 0440 /etc/sudoers.d/90-devin-root \
  && rm -rf /var/lib/apt/lists/*

# Debian does not package uv.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
  && uv --version

COPY --from=devin-cli /usr/local/bin/devin /usr/local/bin/devin
COPY bin/start-devin-worker /usr/local/bin/start-devin-worker
RUN chmod 0755 /usr/local/bin/start-devin-worker && devin --version

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/start-devin-worker"]
