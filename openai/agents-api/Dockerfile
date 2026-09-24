FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      curl \
      git \
      ripgrep \
    && npm install --global @openai/codex@0.154.0-alpha.1 \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /codex-home

COPY bin/start-executor /usr/local/bin/start-executor
RUN chmod +x /usr/local/bin/start-executor

ENV CODEX_HOME=/codex-home
WORKDIR /workspace
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/start-executor"]
