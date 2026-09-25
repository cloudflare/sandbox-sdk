ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-alpine
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
CMD ["sleep", "infinity"]
