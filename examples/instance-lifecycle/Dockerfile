ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
CMD ["sh", "-c", "trap 'echo graceful shutdown; exit 0' TERM; while :; do sleep 3600 & wait $!; done"]
