FROM docker.io/cloudflare/sandbox:0.7.0

# Set HOME to /home/user so OpenCode finds projects there (default /root is empty)
ENV HOME=/home/user

# Add opencode install location to PATH before installation
ENV PATH="${HOME}/.opencode/bin:${PATH}"

# Install OpenCode CLI (create HOME dir first since it doesn't exist yet)
RUN mkdir -p ${HOME} \
    && curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Clone sample project for the web UI to work with
RUN git clone --depth 1 https://github.com/cloudflare/agents.git /home/user/agents

# Start in the sample project directory
WORKDIR /home/user/agents

# Expose OpenCode server port
EXPOSE 4096
