# Use Cloudflare sandbox as base
FROM docker.io/cloudflare/sandbox:0.5.4

# On a mac, you might need to actively pick up the
# arm64 build of the image.
# FROM --platform=linux/arm64 cloudflare/sandbox-test:0.5.4


# Install esbuild for TypeScript bundling
RUN npm install -g esbuild

# Pre-install common validation libraries
WORKDIR /base
RUN npm init -y && \
    npm pkg set type="module" && \
    npm install zod

# Verify installation
RUN node --version && npm --version && esbuild --version

# Set default workspace
WORKDIR /workspace

# Required for local development (preview URLs)
EXPOSE 8080
