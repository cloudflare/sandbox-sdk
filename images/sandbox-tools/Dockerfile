FROM alpine:3.23 AS check-source

# APK verifies repository signatures even when TLS interception prevents the base image from
# trusting the local build environment's certificate authority.
RUN sed -i 's/https:/http:/' /etc/apk/repositories \
    && apk add --no-cache binutils build-base cargo rust rust-clippy rustfmt

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/sandbox-tools/Cargo.toml crates/sandbox-tools/Cargo.toml
COPY crates/sandbox-tools/src crates/sandbox-tools/src

FROM check-source AS check
RUN cargo fmt --all --check
RUN cargo clippy --locked --package sandbox-tools --all-targets -- -D warnings
RUN cargo test --locked --package sandbox-tools
RUN touch /checks-passed

FROM rust:1.91-alpine AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/sandbox-tools/Cargo.toml crates/sandbox-tools/Cargo.toml
COPY crates/sandbox-tools/src crates/sandbox-tools/src
RUN cargo build --release --locked --package sandbox-tools

FROM check-source AS verify
COPY --from=check /checks-passed /checks-passed
COPY --from=build /src/target/release/sandbox-shim /tmp/sandbox-shim
RUN readelf -h /tmp/sandbox-shim | grep -F "Class:                             ELF64"
RUN readelf -h /tmp/sandbox-shim | grep -F "Data:                              2's complement, little endian"
RUN readelf -h /tmp/sandbox-shim | grep -F "Machine:                           Advanced Micro Devices X86-64"
RUN ! readelf -l /tmp/sandbox-shim | grep -F "INTERP"
RUN ! readelf -d /tmp/sandbox-shim | grep -F "(NEEDED)"

FROM scratch AS image
COPY --from=build /src/target/release/sandbox-shim /usr/local/bin/sandbox-shim
