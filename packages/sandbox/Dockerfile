# Sandbox base image with development tools, Python, Node.js, and Bun
FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install essential system packages and development tools
RUN apt-get update && apt-get install -y \
    # Basic utilities
    curl \
    wget \
    git \
    unzip \
    zip \
    # Process management
    procps \
    htop \
    # Build tools
    build-essential \
    pkg-config \
    # Network tools
    net-tools \
    iputils-ping \
    dnsutils \
    # Text processing
    jq \
    vim \
    nano \
    # Python dependencies
    python3.11 \
    python3.11-dev \
    python3-pip \
    # Other useful tools
    sudo \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Set Python 3.11 as default python3
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# Install Node.js 22 LTS
# Using the official NodeSource repository setup script
RUN apt-get update && apt-get install -y ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun using the official installation script
RUN curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && mv /root/.bun/bin/bunx /usr/local/bin/bunx \
    && rm -rf /root/.bun

# Install global npm packages as root
RUN npm install -g yarn pnpm

# Create a non-root user for running applications
RUN useradd -m -s /bin/bash sandbox \
    && echo "sandbox ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set up working directory
WORKDIR /app

# Set ownership of the app directory to sandbox user
RUN chown -R sandbox:sandbox /app

# Set environment variables
ENV PATH="/home/sandbox/.local/bin:${PATH}"

# Switch to non-root user
USER sandbox

# Verify installations
RUN python3 --version && \
    node --version && \
    npm --version && \
    bun --version && \
    yarn --version && \
    pnpm --version

# Copy container source files
COPY --chown=sandbox:sandbox container_src/* ./

# Expose the application port
EXPOSE 3000

# Run the application
CMD ["bun", "index.ts"]
