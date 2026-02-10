FROM docker.io/cloudflare/sandbox:0.7.1 AS sandbox-source

FROM alpine:3.21

RUN apk add --no-cache file git

COPY --from=sandbox-source /container-server/sandbox-musl /sandbox

WORKDIR /workspace

EXPOSE 3000 8080

ENTRYPOINT ["/sandbox"]
