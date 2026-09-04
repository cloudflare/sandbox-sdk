ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace/directory \
    /workspace/remove-directory \
    && printf 'hello from sandbox\n' > /workspace/fixture.txt \
    && printf 'nested file\n' > /workspace/directory/nested.txt \
    && printf 'rename me\n' > /workspace/rename-source.txt \
    && printf 'remove me\n' > /workspace/remove-file.txt \
    && printf 'remove nested\n' > /workspace/remove-directory/nested.txt \
    && ln -s fixture.txt /workspace/link.txt \
    && ln -s fixture.txt /workspace/remove-link
CMD ["sleep", "infinity"]
