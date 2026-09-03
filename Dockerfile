FROM alpine:3.23 AS toolchain

RUN apk add --no-cache binutils build-base cargo rust rust-clippy rustfmt

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/sandbox-tools/Cargo.toml crates/sandbox-tools/Cargo.toml
COPY crates/sandbox-tools/src crates/sandbox-tools/src
COPY crates/sandbox-tools/tests crates/sandbox-tools/tests

FROM toolchain AS check
RUN cargo fmt --all --check
RUN cargo clippy --locked --package sandbox-tools --all-targets -- -D warnings
RUN cargo test --locked --package sandbox-tools
RUN touch /checks-passed

FROM toolchain AS build
ENV RUSTFLAGS="-C target-feature=+crt-static"
RUN cargo build --release --locked --package sandbox-tools

FROM toolchain AS verify
COPY --from=check /checks-passed /checks-passed
COPY --from=build /src/target/release/sandbox-shim /tmp/sandbox-shim
RUN readelf -h /tmp/sandbox-shim | grep -F "Class:                             ELF64"
RUN readelf -h /tmp/sandbox-shim | grep -F "Data:                              2's complement, little endian"
RUN readelf -h /tmp/sandbox-shim | grep -F "Machine:                           Advanced Micro Devices X86-64"
RUN ! readelf -l /tmp/sandbox-shim | grep -F "INTERP"
RUN ! readelf -d /tmp/sandbox-shim | grep -F "(NEEDED)"

FROM scratch AS image
COPY --from=build /src/target/release/sandbox-shim /usr/local/bin/sandbox-shim

FROM alpine:3.23 AS e2e
COPY --from=build /src/target/release/sandbox-shim /usr/local/bin/sandbox-shim
RUN printf 'hello from sandbox\n' > /fixture.txt
CMD ["sleep", "infinity"]
