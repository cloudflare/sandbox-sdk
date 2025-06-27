# syntax=docker/dockerfile:1

FROM oven/bun:alpine AS builder

# Add build dependencies
RUN apk add --no-cache \
    python3 \
    py3-pip \
    build-base \
    gcc \
    g++ \
    musl-dev \
    linux-headers \
    libffi-dev \
    openssl-dev \
    python3-dev \
    nodejs \
    npm

# Install global Node.js packages for extended functionality
RUN npm install -g \
    typescript@5.1.6 \
    ts-node@10.9.1 \
    nodemon@2.0.22 \
    pm2@5.3.0 \
    # Testing frameworks
    jest@29.6.1 \
    mocha@10.2.0 \
    vitest@0.34.1 \
    # Build tools
    webpack@5.88.0 \
    vite@4.4.9 \
    rollup@3.29.0 \
    esbuild@0.19.2 \
    # Linting and formatting
    eslint@8.50.0 \
    prettier@3.0.3 \
    # Development utilities
    concurrently@8.2.0 \
    cross-env@7.0.3 \
    # Database tools
    prisma@5.2.0 \
    # API development
    express-generator@4.17.1 \
    # GraphQL
    @graphql-codegen/cli@3.2.2 \
    # Documentation
    typedoc@0.24.9 && \
    # Clean npm cache
    npm cache clean --force

# Create package.json for commonly used packages
RUN echo '{"dependencies": {}}' > /tmp/package.json
WORKDIR /tmp

# Install commonly used Node packages in a temporary location
RUN npm install \
    # Web frameworks (essential for LLM web apps)
    express \
    fastify \
    koa \
    # Database (popular for LLM applications)
    mongoose \
    sequelize \
    typeorm \
    # Utilities (commonly requested by LLMs)
    lodash \
    dayjs \
    uuid \
    chalk \
    commander \
    # HTTP clients (essential for API integrations)
    axios \
    node-fetch \
    # File processing (important for LLM document tasks)
    csv-parser \
    xml2js \
    # Validation (security-focused)
    joi \
    yup \
    ajv \
    # Crypto (authentication)
    bcrypt \
    jsonwebtoken \
    # WebSocket (real-time features)
    socket.io \
    ws && \
    # Cleanup
    find /tmp/node_modules -name "*.md" -delete && \
    find /tmp/node_modules -name "test" -type d -exec rm -rf {} + 2>/dev/null || true && \
    find /tmp/node_modules -name "tests" -type d -exec rm -rf {} + 2>/dev/null || true && \
    find /tmp/node_modules -name "*.test.js" -delete && \
    find /tmp/node_modules -name "*.spec.js" -delete

FROM oven/bun:alpine AS runtime

# Install minimal runtime dependencies
RUN apk add --no-cache \
    python3 \
    py3-pip \
    nodejs \
    npm \
    # Runtime libs
    libffi \
    openssl

# Copy global packages and node_modules
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /tmp/node_modules /app/node_modules

# Clean up
RUN rm -rf /var/cache/apk/* /tmp/* /var/tmp/*

WORKDIR /app

# Copy the container source from the sandbox package
COPY ./node_modules/@cloudflare/sandbox/container_src .

EXPOSE 3000

CMD ["bun", "run", "index.ts"]