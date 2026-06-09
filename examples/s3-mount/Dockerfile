FROM docker.io/cloudflare/sandbox:0.12.1

# mount-s3 (mountpoint-s3) — pinned version with SHA-256 verification per architecture
ARG MOUNT_S3_VERSION=1.22.3
ARG MOUNT_S3_SHA256_AMD64=259a793b1233258b35ce5ce902df177393542fd76dd2a606f07e800e28591df6
ARG MOUNT_S3_SHA256_ARM64=988dc5197fa91506fda4cf7c902ca55eb8a1e22fc341d1a9268723c90c6c72af

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) arch_path=x86_64; sha="${MOUNT_S3_SHA256_AMD64}" ;; \
      arm64) arch_path=arm64;  sha="${MOUNT_S3_SHA256_ARM64}" ;; \
      *) echo "Unsupported arch for mount-s3: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://s3.amazonaws.com/mountpoint-s3-release/latest/${arch_path}/mount-s3.deb"; \
    curl -fsSL -o /tmp/mount-s3.deb "$url"; \
    echo "$sha  /tmp/mount-s3.deb" | sha256sum -c -; \
    apt-get install -y /tmp/mount-s3.deb; \
    rm -f /tmp/mount-s3.deb; \
    apt-get clean; \
    mount-s3 --version

# Create the S3 mount point
RUN mkdir -p /mnt/s3

# Documents the ports this application uses (standard Docker convention)
EXPOSE 8080
