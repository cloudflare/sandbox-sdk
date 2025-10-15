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

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

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
RUN npm ci --production

# ============================================================================
# Stage 4: Runtime - Ubuntu 22.04 with full development environment
# ============================================================================
FROM ubuntu:22.04 AS runtime

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
    file \
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
    ca-certificates \
    gnupg \
    lsb-release \
    strace \
    && rm -rf /var/lib/apt/lists/*

# Set Python 3.11 as default python3
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# Install Node.js 20 LTS using official NodeSource setup script
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun runtime from official image
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=oven/bun:1 /usr/local/bin/bunx /usr/local/bin/bunx

# Install essential Python packages for code execution
RUN pip3 install --no-cache-dir \
    matplotlib \
    numpy \
    pandas \
    ipython

# Verify installations
RUN python3 --version && \
    node --version && \
    npm --version && \
    bun --version

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

# Copy workspace packages so node_modules symlinks work
# @repo/shared and @repo/typescript-config are symlinked in node_modules
COPY --from=prod-deps /app/packages/shared ./packages/shared
COPY --from=prod-deps /app/tooling/typescript-config ./tooling/typescript-config

# Configure process pool sizes (can be overridden at runtime)
ENV PYTHON_POOL_MIN_SIZE=3
ENV PYTHON_POOL_MAX_SIZE=15
ENV JAVASCRIPT_POOL_MIN_SIZE=3
ENV JAVASCRIPT_POOL_MAX_SIZE=10
ENV TYPESCRIPT_POOL_MIN_SIZE=3
ENV TYPESCRIPT_POOL_MAX_SIZE=10

# Create clean workspace directory for user code
# Architecture:
#   /container-server/ - SDK infrastructure (server, executors, dependencies)
#   /workspace/ - User's clean workspace for their code
RUN mkdir -p /workspace

# Expose the application port (3000 for control)
EXPOSE 3000

# Copy and make startup script executable
COPY packages/sandbox/startup.sh ./
RUN chmod +x startup.sh

# Use startup script
CMD ["./startup.sh"]
