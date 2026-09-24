FROM alpine:3.23 AS toolchain

# Steps that download take an optional extra_ca secret for networks that inspect TLS.
RUN --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    apk add --no-cache binutils build-base cargo rust rust-clippy rustfmt

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/sandbox-tools/Cargo.toml crates/sandbox-tools/Cargo.toml
COPY crates/sandbox-tools/src crates/sandbox-tools/src
COPY crates/sandbox-tools/tests crates/sandbox-tools/tests
RUN --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/extra_ca; fi; \
    cargo fetch --locked

FROM toolchain AS check
RUN cargo fmt --all --check
RUN cargo clippy --locked --package sandbox-tools --all-targets -- -D warnings
RUN cargo test --locked --package sandbox-tools
RUN touch /checks-passed

FROM toolchain AS build
RUN cargo rustc --release --locked --package sandbox-tools --bin sandbox-shim -- -C target-feature=+crt-static

FROM alpine:3.23 AS contract
RUN --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    apk add --no-cache nodejs npm
WORKDIR /src
COPY package.json package-lock.json tsconfig.json vite.config.ts ./
COPY packages/sandbox/package.json packages/sandbox/package.json
RUN --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci
COPY packages/sandbox packages/sandbox
COPY --from=build /src/target/release/sandbox-shim /usr/local/bin/sandbox-shim
ENV SANDBOX_SHIM_PATH=/usr/local/bin/sandbox-shim
RUN npm exec -- vp test --run packages/sandbox/tests/shim-contract.test.mjs
RUN touch /contract-passed

FROM toolchain AS verify
COPY --from=check /checks-passed /checks-passed
COPY --from=contract /contract-passed /contract-passed
COPY --from=build /src/target/release/sandbox-shim /tmp/sandbox-shim
RUN readelf -h /tmp/sandbox-shim | grep -F "Class:                             ELF64"
RUN readelf -h /tmp/sandbox-shim | grep -F "Data:                              2's complement, little endian"
RUN readelf -h /tmp/sandbox-shim | grep -F "Machine:                           Advanced Micro Devices X86-64"
RUN ! readelf -l /tmp/sandbox-shim | grep -F "INTERP"
RUN ! readelf -d /tmp/sandbox-shim | grep -F "(NEEDED)"

# This image is a donor stage for user-owned runtime images, not a runnable container.
FROM scratch AS image
COPY --from=build /src/target/release/sandbox-shim /usr/local/bin/sandbox-shim
