ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254

FROM ${UBUNTU_IMAGE}

ARG S3FS_VERSION=1.93-1build3

# A stalled mirror connection times out and retries instead of hanging the build.
RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 \
        install --yes --no-install-recommends \
        ca-certificates \
        fuse3 \
        procps \
        "s3fs=${S3FS_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
