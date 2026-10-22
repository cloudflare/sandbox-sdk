# Adds the shim under test to the s3fs fixture image. Both base images are local, so this build
# downloads nothing.
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
ARG S3FS_IMAGE

FROM ${SANDBOX_TOOLS_IMAGE} AS tools

FROM ${S3FS_IMAGE}
COPY --from=tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
CMD ["sleep", "infinity"]
