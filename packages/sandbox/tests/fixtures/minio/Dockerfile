# MinIO no longer publishes container images, so the S3 tests build one from the server binaries
# on MinIO's GitHub release. The checksums are the ones the release publishes.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254

FROM scratch AS minio-amd64
ADD --checksum=sha256:7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f \
    https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z \
    /minio

FROM scratch AS minio-arm64
ADD --checksum=sha256:5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d \
    https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-arm64.RELEASE.2025-09-07T16-13-09Z \
    /minio

FROM minio-${TARGETARCH} AS minio

FROM ${UBUNTU_IMAGE}
COPY --from=minio --chmod=755 /minio /usr/local/bin/minio
ENTRYPOINT ["minio"]
