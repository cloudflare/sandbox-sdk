FROM rust:1-alpine AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/sandbox-tools/Cargo.toml crates/sandbox-tools/Cargo.toml
COPY crates/sandbox-tools/src crates/sandbox-tools/src
RUN cargo build --release --locked --package sandbox-tools

FROM scratch
COPY --from=build /src/target/release/sandbox-shim /usr/local/bin/sandbox-shim
