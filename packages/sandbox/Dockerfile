# Sandbox base image with development tools, Python, Node.js, and Bun
FROM oven/bun:latest AS bun-source
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
    python3.11-venv \
    # Other useful tools
    sudo \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Set Python 3.11 as default python3
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# Install Node.js 20 LTS (matching E2B's setup)
# Using the official NodeSource repository setup script
RUN apt-get update && apt-get install -y ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun from official image (avoids architecture compatibility issues)
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-source /usr/local/bin/bunx /usr/local/bin/bunx

# Install Jupyter and kernels
RUN pip3 install --no-cache-dir \
    jupyter \
    jupyterlab \
    ipykernel \
    notebook \
    matplotlib \
    numpy \
    pandas \
    seaborn \
    && python3 -m ipykernel install --user --name python3

# Install JavaScript kernel (ijavascript) - using E2B's fork
RUN npm install -g --unsafe-perm git+https://github.com/e2b-dev/ijavascript.git \
    && ijsinstall --install=global

# Set up container server directory
WORKDIR /container-server

# Verify installations
RUN python3 --version && \
    node --version && \
    npm --version && \
    bun --version && \
    jupyter --version && \
    jupyter kernelspec list

# Copy container source files to server directory
COPY container_src/package.json ./
RUN bun install

COPY container_src/ ./

# Create clean workspace directory for users
RUN mkdir -p /workspace

# Expose the application port (3000 for control, 8888 for Jupyter)
EXPOSE 3000 8888

# Make startup script executable
RUN chmod +x startup.sh

# Use startup script
CMD ["./startup.sh"]
