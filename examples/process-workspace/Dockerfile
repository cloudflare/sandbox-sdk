ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

# Debian includes setsid and a tail that supports --pid.
FROM debian:trixie-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN setsid --version >/dev/null && tail --version >/dev/null && mkdir -p /workspace
CMD ["sleep", "infinity"]
