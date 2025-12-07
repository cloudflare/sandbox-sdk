FROM docker.io/cloudflare/sandbox:0.6.3

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
# Download script first, then run - this shows errors instead of failing silently
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Expose OpenCode server port
EXPOSE 4096
