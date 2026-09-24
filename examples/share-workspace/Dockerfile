ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools
FROM cloudflare/cloudflared:2026.3.0 AS cloudflared

# python3 gives the example a server to share. Use your own servers instead.
FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
