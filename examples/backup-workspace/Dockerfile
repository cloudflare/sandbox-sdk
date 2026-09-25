ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM debian:trixie-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
CMD ["sleep", "infinity"]
