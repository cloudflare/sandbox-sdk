FROM docker.io/cloudflare/sandbox:0.6.6

# Install Claude Code CLI globally and the Agent SDK (reproducing issue #309)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Also install the agent SDK for testing
RUN mkdir -p /opt/agent-test && cd /opt/agent-test && \
    npm init -y && \
    npm install @anthropic-ai/claude-agent-sdk

ENV PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Required during local development to access exposed ports
EXPOSE 8080
