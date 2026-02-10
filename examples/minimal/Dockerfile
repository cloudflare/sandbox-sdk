# Use the sandbox binary on an Alpine base image
# This demonstrates the standalone binary pattern with a minimal image
FROM docker.io/cloudflare/sandbox:0.7.1 AS sandbox-source

FROM alpine:3.21

# gcompat: glibc compatibility layer (sandbox binary requires it)
# file: MIME type detection for SDK file operations
# git: required for gitCheckout SDK method
RUN apk add --no-cache gcompat file git

COPY --from=sandbox-source /container-server/sandbox-musl /sandbox

WORKDIR /workspace

# Port 3000: sandbox HTTP API (required)
# Port 8080: available for user services during local development
EXPOSE 3000 8080

ENTRYPOINT ["/sandbox"]
