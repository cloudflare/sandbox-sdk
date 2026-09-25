ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254

FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM ${UBUNTU_IMAGE}

ARG S3FS_VERSION=1.93-1build3

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        ca-certificates \
        fuse3 \
        "s3fs=${S3FS_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
CMD ["sleep", "infinity"]
