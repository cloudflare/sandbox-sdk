FROM docker.io/cloudflare/sandbox:0.7.8

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Clone sample project for the web UI to work with
RUN git clone --depth 1 https://github.com/octocat/Hello-World.git /home/user/Hello-World

# Start in the sample project directory
WORKDIR /home/user/Hello-World

# Expose OpenCode server port
EXPOSE 4096
