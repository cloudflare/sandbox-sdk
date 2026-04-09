FROM docker.io/cloudflare/sandbox:0.8.8-opencode

# Clone sample project for the web UI to work with
RUN git clone --depth 1 https://github.com/cloudflare/agents.git /home/user/agents

# Start in the sample project directory
WORKDIR /home/user/agents

# Expose OpenCode server port
EXPOSE 4096
