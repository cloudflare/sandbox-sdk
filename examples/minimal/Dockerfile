FROM docker.io/cloudflare/sandbox:0.7.4

# zstd for compression, squashfs-tools for mksquashfs/unsquashfs benchmarks
RUN apt-get update && apt-get install -y --no-install-recommends zstd squashfs-tools && rm -rf /var/lib/apt/lists/*

# Clone sandbox-sdk and install deps — gives us a realistic directory tree to benchmark against
RUN git clone --depth 1 https://github.com/cloudflare/sandbox-sdk.git /workspace/sandbox-sdk && \
    cd /workspace/sandbox-sdk && \
    npm install --ignore-scripts --no-optional --no-audit --no-fund

EXPOSE 8080 8081 8082
