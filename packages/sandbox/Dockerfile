# Sandbox container images (default and python variants)
# Multi-stage build optimized for Turborepo monorepo

# ============================================================================
# Stage 1: Prune monorepo to only include necessary packages
# ============================================================================
FROM node:20-slim AS pruner

WORKDIR /app

RUN npm install -g turbo

COPY . .

# Prune to only @repo/sandbox-container and its dependencies (@repo/shared)
# The --docker flag generates out/json and out/full directories
RUN turbo prune @repo/sandbox-container --docker

# ============================================================================
# Stage 2: Install dependencies and build packages
# Using glibc-based images (not Alpine) so the standalone binary works on
# standard Linux distributions (Debian, Ubuntu, RHEL, etc.)
# ============================================================================
FROM node:20-slim AS builder

WORKDIR /app

# Install Bun runtime (glibc version for glibc-compatible standalone binary)
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# Copy pruned lockfile and package.json files (for Docker layer caching)
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install ALL dependencies with cache mount for npm packages
RUN --mount=type=cache,target=/root/.npm \
    CI=true npm ci

COPY --from=pruner /app/out/full/ .

# Build all packages (Turborepo handles dependency order automatically)
# This builds @repo/shared first, then @repo/sandbox-container (including standalone binary)
RUN npx turbo run build

# ============================================================================
# Stage 3: Download pre-built Python 3.11.14
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
# Stage 4: Runtime base - Ubuntu 22.04 with Node.js and Bun (no Python)
# ============================================================================
FROM ubuntu:22.04 AS runtime-base

# Accept version as build argument (passed from npm_package_version)
ARG SANDBOX_VERSION=unknown

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

ENV SANDBOX_VERSION=${SANDBOX_VERSION}

# Install runtime packages and S3FS-FUSE for bucket mounting
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
    apt-get update && apt-get install -y --no-install-recommends \
    s3fs fuse \
    ca-certificates curl wget procps git unzip zip jq file \
    libssl3 zlib1g libbz2-1.0 libreadline8 libsqlite3-0 \
    libncursesw6 libtinfo6 libxml2 libxmlsec1 libffi8 liblzma5 libtk8.6 && \
    update-ca-certificates

# Enable FUSE in container - allow non-root users to use FUSE
RUN sed -i 's/#user_allow_other/user_allow_other/' /etc/fuse.conf

# Install Node.js 20 LTS from official Node image
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Install Bun runtime from official image
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# Copy standalone binary
COPY --from=builder /app/packages/sandbox-container/dist/sandbox /container-server/sandbox

# Set up container server directory for executors
WORKDIR /container-server

# Copy bundled JavaScript executor (runs on Node or Bun for code interpreter)
COPY --from=builder /app/packages/sandbox-container/dist/runtime/executors/javascript/node_executor.js ./dist/runtime/executors/javascript/

# Copy legacy JS bundle for backwards compatibility
# Users with custom startup scripts that call `bun /container-server/dist/index.js` need this
COPY --from=builder /app/packages/sandbox-container/dist/index.js ./dist/

RUN mkdir -p /workspace

# Expose the application port (3000 for control)
EXPOSE 3000

# ============================================================================
# Stage 5a: Default image - lean, no Python
# ============================================================================
FROM runtime-base AS default

# Disable Python pool (Python not available in this image)
ENV PYTHON_POOL_MIN_SIZE=0
ENV JAVASCRIPT_POOL_MIN_SIZE=3
ENV TYPESCRIPT_POOL_MIN_SIZE=3

ENTRYPOINT ["/container-server/sandbox"]

# ============================================================================
# Stage 5b: Python image - full, with Python + data science packages
# ============================================================================
FROM runtime-base AS python

# Copy pre-built Python from python-builder stage
COPY --from=python-builder /usr/local/python /usr/local/python

# Create symlinks and update shared library cache
RUN ln -s /usr/local/python/bin/python3.11 /usr/local/bin/python3.11 && \
    ln -s /usr/local/python/bin/python3 /usr/local/bin/python3 && \
    ln -s /usr/local/python/bin/pip3 /usr/local/bin/pip3 && \
    echo "/usr/local/python/lib" > /etc/ld.so.conf.d/python.conf && \
    ldconfig

# Set Python 3.11 as default python3
RUN update-alternatives --install /usr/bin/python3 python3 /usr/local/bin/python3.11 1

# Install Python packages for data science and code interpreter
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --no-cache-dir matplotlib numpy pandas ipython

# Copy Python executor
COPY --from=builder /app/packages/sandbox-container/src/runtime/executors/python/ipython_executor.py ./dist/runtime/executors/python/

# Enable all interpreter pools
ENV PYTHON_POOL_MIN_SIZE=3
ENV JAVASCRIPT_POOL_MIN_SIZE=3
ENV TYPESCRIPT_POOL_MIN_SIZE=3

ENTRYPOINT ["/container-server/sandbox"]

# ============================================================================
# Stage 5c: OpenCode image - with OpenCode CLI for AI coding agent
# ============================================================================
FROM runtime-base AS opencode

# Add opencode to PATH
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Disable Python pool (Python not available in this image)
ENV PYTHON_POOL_MIN_SIZE=0
ENV JAVASCRIPT_POOL_MIN_SIZE=3
ENV TYPESCRIPT_POOL_MIN_SIZE=3

# Expose OpenCode server port (in addition to 3000 from runtime-base)
EXPOSE 4096

ENTRYPOINT ["/container-server/sandbox"]
