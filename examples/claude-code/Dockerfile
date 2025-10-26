FROM docker.io/cloudflare/sandbox:0.4.7
RUN npm install -g @anthropic-ai/claude-code
ENV COMMAND_TIMEOUT_MS=300000
EXPOSE 3000

# On a Mac with Apple Silicon, you might need to specify the platform:
# FROM --platform=linux/arm64 docker.io/cloudflare/sandbox:0.4.4
