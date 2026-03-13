FROM docker.io/cloudflare/sandbox:0.7.17
RUN npm install -g @anthropic-ai/claude-code
ENV COMMAND_TIMEOUT_MS=300000
# Override with --build-arg BUILD_INTERNAL_SERVER_PORT=<port> if using a custom control port
EXPOSE 8671
