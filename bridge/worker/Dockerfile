# Base image provided by Cloudflare — includes the sandbox control-plane server
# that listens on port 3000 and handles all SDK API calls.
FROM docker.io/cloudflare/sandbox:0.8.11

# Install tooling for UC workspace operations and agent use.
# The base image is Debian-based and includes sh, ls, rm, mkdir, cp, etc.
# tar        - persist_workspace / hydrate_workspace
# git        - version control (log, blame, diff, status, commit, restore, revert)
# curl/wget  - HTTP fetching
# ripgrep    - preferred by agent prompts for text/file search (rg, rg --files)
# jq         - JSON processing
# procps     - process management (ps, pkill, kill)
# sed/gawk   - text processing utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    tar \
    git \
    curl \
    wget \
    ripgrep \
    jq \
    procps \
    sed \
    gawk \
    && rm -rf /var/lib/apt/lists/*

# fusermount requires /etc/mtab to find active mounts. The base image does not
# include it, causing `fusermount -u` to fail silently during bucket unmount.
RUN ln -sf /proc/mounts /etc/mtab

# Install uv (Python package manager) and use it to install Python 3.13.
# uv is installed to /usr/local/bin so it's available to all users.
# Python is installed to a shared location and symlinked into PATH.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python
RUN uv python install 3.13 \
    && ln -s $(uv python find 3.13) /usr/local/bin/python3 \
    && ln -s /usr/local/bin/python3 /usr/local/bin/python

# Workspace root used by the sandbox service.
RUN mkdir -p /workspace

# Create a non-root user for sandbox operations.
# Commands executed via sandbox.exec() will run as this user, limiting access
# to sensitive system files and providing defense-in-depth.
RUN useradd -m -s /bin/bash -d /home/sandbox sandbox \
    && chown sandbox:sandbox /workspace \
    && chmod 700 /root

USER sandbox
WORKDIR /workspace
