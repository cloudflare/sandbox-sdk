# Sandbox container image with full development environment
# Multi-stage build optimized for Turborepo monorepo

# ============================================================================
# Stage 1: Prune monorepo to only include necessary packages
# ============================================================================
FROM node:20-alpine AS pruner

WORKDIR /app

# Install Turborepo globally
RUN npm install -g turbo

# Copy entire monorepo
COPY . .

# Prune to only @repo/sandbox-container and its dependencies (@repo/shared)
# The --docker flag generates out/json and out/full directories
RUN turbo prune @repo/sandbox-container --docker

# ============================================================================
# Stage 2: Install dependencies and build packages
# ============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy pruned lockfile and package.json files (for Docker layer caching)
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install ALL dependencies with cache mount for npm packages
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy pruned source code
COPY --from=pruner /app/out/full/ .

# Build all packages (Turborepo handles dependency order automatically)
# This builds @repo/shared first, then @repo/sandbox-container
RUN npx turbo run build

# ============================================================================
# Stage 3: Install production-only dependencies
# ============================================================================
FROM node:20-alpine AS prod-deps

WORKDIR /app

# Copy package files from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/tooling ./tooling

# Install ONLY production dependencies (excludes typescript, @types/*, etc.)
RUN --mount=type=cache,target=/root/.npm \
    npm ci --production

# ============================================================================
# Stage 4: Runtime - Ubuntu 22.04 with only runtime dependencies
# ============================================================================
FROM ubuntu:22.04 AS runtime

# Accept version as build argument (passed from npm_package_version)
ARG SANDBOX_VERSION=unknown

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set the sandbox version as an environment variable for version checking
ENV SANDBOX_VERSION=${SANDBOX_VERSION}

# Install essential runtime packages with cache mounts
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
    apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    ca-certificates \
    procps \
    git \
    unzip \
    zip \
    jq \
    file \
    # Build dependencies for Python
    build-essential \
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libncursesw5-dev \
    xz-utils \
    tk-dev \
    libxml2-dev \
    libxmlsec1-dev \
    libffi-dev \
    liblzma-dev

# Download and build Python 3.11.11 from source
RUN cd /tmp && \
    wget https://www.python.org/ftp/python/3.11.11/Python-3.11.11.tar.xz && \
    tar -xf Python-3.11.11.tar.xz && \
    cd Python-3.11.11 && \
    ./configure --enable-optimizations --with-lto --prefix=/usr/local && \
    make -j$(nproc) && \
    make altinstall && \
    cd / && \
    rm -rf /tmp/Python-3.11.11*

# Set Python 3.11 as default python3 and install pip
RUN update-alternatives --install /usr/bin/python3 python3 /usr/local/bin/python3.11 1 && \
    /usr/local/bin/python3.11 -m ensurepip && \
    /usr/local/bin/python3.11 -m pip install --upgrade pip

# Install Node.js 20 LTS using official NodeSource setup script
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun runtime from official image
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# Install essential Python packages with cache mount
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install \
    matplotlib \
    numpy \
    pandas \
    ipython

# Mark runtime libraries as manually installed to prevent autoremove
RUN apt-mark manual \
    libssl3 \
    zlib1g \
    libbz2-1.0 \
    libreadline8 \
    libsqlite3-0 \
    libncursesw6 \
    libtinfo6 \
    libxml2 \
    libxmlsec1 \
    libffi8 \
    liblzma5 \
    libtk8.6

# Remove build dependencies to reduce image size (Python and packages are already compiled)
RUN apt-get remove -y \
    build-essential \
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libncursesw5-dev \
    xz-utils \
    tk-dev \
    libxml2-dev \
    libxmlsec1-dev \
    libffi-dev \
    liblzma-dev && \
    apt-get autoremove -y && \
    apt-get clean

# Set up runtime container server directory
WORKDIR /container-server

# Copy built sandbox-container package
COPY --from=builder /app/packages/sandbox-container/dist ./dist
COPY --from=builder /app/packages/sandbox-container/package.json ./package.json

# Copy Python executor to runtime location
COPY --from=builder /app/packages/sandbox-container/src/runtime/executors/python/ipython_executor.py ./dist/runtime/executors/python/

# Copy production-only node_modules (excludes typescript, @types/*, etc.)
# Includes: @repo/shared, zod, esbuild (runtime dependencies)
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy workspace packages
COPY --from=prod-deps /app/packages/shared/dist ./packages/shared/dist
COPY --from=prod-deps /app/packages/shared/package.json ./packages/shared/package.json

# Configure process pool sizes (can be overridden at runtime)
ENV PYTHON_POOL_MIN_SIZE=3
ENV PYTHON_POOL_MAX_SIZE=15
ENV JAVASCRIPT_POOL_MIN_SIZE=3
ENV JAVASCRIPT_POOL_MAX_SIZE=10
ENV TYPESCRIPT_POOL_MIN_SIZE=3
ENV TYPESCRIPT_POOL_MAX_SIZE=10

# Create clean workspace directory for user code
RUN mkdir -p /workspace

# Expose the application port (3000 for control)
EXPOSE 3000

# Copy and make startup script executable
COPY packages/sandbox/startup.sh ./
RUN chmod +x startup.sh

# Use startup script
CMD ["./startup.sh"]
