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
# Stage 4: Download pre-built Python 3.11.14
# ============================================================================
FROM ubuntu:22.04 AS python-builder

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Accept architecture from Docker BuildKit (for multi-arch builds)
ARG TARGETARCH

# Install minimal dependencies for downloading
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
    apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates

# Download and extract pre-built Python 3.11.14 from python-build-standalone
# Using PGO+LTO optimized builds for better performance
# Supports multi-arch: amd64 (x86_64) and arm64 (aarch64)
RUN --mount=type=cache,target=/tmp/python-cache \
    # Map Docker TARGETARCH to python-build-standalone arch naming
    if [ "$TARGETARCH" = "amd64" ]; then \
        PYTHON_ARCH="x86_64-unknown-linux-gnu"; \
        EXPECTED_SHA256="edd8d11aa538953d12822fab418359a692fd1ee4ca2675579fbf0fa31e3688f1"; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        PYTHON_ARCH="aarch64-unknown-linux-gnu"; \
        EXPECTED_SHA256="08141d31f95d86a23f23e4c741b726de0055f12f83200d1d4867b4e8e6e967c5"; \
    else \
        echo "Unsupported architecture: $TARGETARCH" && exit 1; \
    fi && \
    cd /tmp/python-cache && \
    wget -nc https://github.com/indygreg/python-build-standalone/releases/download/20251028/cpython-3.11.14+20251028-${PYTHON_ARCH}-install_only.tar.gz && \
    # Verify SHA256 checksum for security
    echo "${EXPECTED_SHA256}  cpython-3.11.14+20251028-${PYTHON_ARCH}-install_only.tar.gz" | sha256sum -c - && \
    cd /tmp && \
    tar -xzf /tmp/python-cache/cpython-3.11.14+20251028-${PYTHON_ARCH}-install_only.tar.gz && \
    mv python /usr/local/ && \
    rm -rf /tmp/cpython-*

# ============================================================================
# Stage 5: Runtime - Ubuntu 22.04 with only runtime dependencies
# ============================================================================
FROM ubuntu:22.04 AS runtime

# Accept version as build argument (passed from npm_package_version)
ARG SANDBOX_VERSION=unknown

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set the sandbox version as an environment variable for version checking
ENV SANDBOX_VERSION=${SANDBOX_VERSION}

# Install runtime packages and Python runtime libraries
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget procps git unzip zip jq \
    libssl3 zlib1g libbz2-1.0 libreadline8 libsqlite3-0 \
    libncursesw6 libtinfo6 libxml2 libxmlsec1 libffi8 liblzma5 libtk8.6 && \
    update-ca-certificates

# Copy pre-built Python from python-builder stage
COPY --from=python-builder /usr/local/python /usr/local/python

# Create symlinks and update shared library cache
RUN ln -s /usr/local/python/bin/python3.11 /usr/local/bin/python3.11 && \
    ln -s /usr/local/python/bin/python3 /usr/local/bin/python3 && \
    ln -s /usr/local/python/bin/pip3 /usr/local/bin/pip3 && \
    echo "/usr/local/python/lib" > /etc/ld.so.conf.d/python.conf && \
    ldconfig

# Set Python 3.11 as default python3 and clean up
RUN update-alternatives --install /usr/bin/python3 python3 /usr/local/bin/python3.11 1 && \
    # Remove unnecessary Python files to reduce image size
    # Safe to remove: stdlib test directories are only used during Python development, not runtime
    # Error suppression is necessary: find encounters expected errors when parent dirs are deleted first
    find /usr/local/python/lib/python3.11 -type d -name "test" -exec rm -rf {} + 2>/dev/null || true && \
    find /usr/local/python/lib/python3.11 -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /usr/local/python/lib/python3.11 -name "*.pyc" -delete && \
    find /usr/local/python/lib/python3.11 -name "*.pyo" -delete && \
    find /usr/local/python/lib/python3.11 -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# Install Python packages and clean up
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --no-cache-dir matplotlib numpy pandas ipython && \
    # Remove test files and caches from installed packages to reduce image size
    # Safe to remove: test directories in site-packages are only for package self-tests, not runtime use
    # Error suppression is necessary: find encounters expected errors when parent dirs are deleted first
    find /usr/local/python/lib/python3.11/site-packages -type d -name "test" -exec rm -rf {} + 2>/dev/null || true && \
    find /usr/local/python/lib/python3.11/site-packages -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /usr/local/python/lib/python3.11/site-packages -name "*.pyc" -delete && \
    find /usr/local/python/lib/python3.11/site-packages -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# Install Node.js 20 LTS from official Node image
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Install Bun runtime from official image
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

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
