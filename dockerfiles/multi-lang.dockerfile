# syntax=docker/dockerfile:1

FROM oven/bun:alpine AS builder

# Install build dependencies and languages
RUN apk add --no-cache \
    # Build tools
    build-base \
    gcc \
    g++ \
    musl-dev \
    linux-headers \
    git \
    curl \
    wget \
    # Python
    python3 \
    py3-pip \
    python3-dev \
    libffi-dev \
    openssl-dev \
    # Node.js
    nodejs \
    npm \
    # Go
    go \
    # Java
    openjdk11 \
    # Ruby
    ruby \
    ruby-dev \
    # R
    R \
    R-dev \
    # Image processing libraries
    jpeg-dev \
    zlib-dev \
    freetype-dev

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:$PATH"

# Install uv for Python packages
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install Python packages
RUN uv pip install --system --break-system-packages --no-cache \
    # Core data science
    numpy pandas matplotlib seaborn scipy scikit-learn \
    # ML frameworks
    torch transformers \
    # Utilities
    requests beautifulsoup4 jupyter \
    # Web frameworks
    flask fastapi uvicorn \
    # File processing
    pillow openpyxl PyPDF2 python-docx && \
    # Cleanup Python
    find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true && \
    find /usr -type f -name "*.pyc" -delete

# Install Node.js global packages
RUN npm install -g \
    typescript \
    ts-node \
    webpack \
    vite \
    eslint \
    prettier \
    express && \
    npm cache clean --force

# Install Ruby gems
RUN gem install \
    rails \
    sinatra \
    bundler \
    --no-document

# Install Go packages
RUN go install github.com/gorilla/mux@latest && \
    go install github.com/gin-gonic/gin@latest

# Install R packages
RUN R -e "install.packages(c('ggplot2', 'dplyr', 'tidyr', 'readr'), repos='https://cran.rstudio.com/', quiet=TRUE)"

FROM oven/bun:alpine AS runtime

# Install minimal runtime dependencies
RUN apk add --no-cache \
    # Languages
    python3 \
    py3-pip \
    nodejs \
    npm \
    go \
    openjdk11-jre \
    ruby \
    R \
    # Runtime libraries
    libffi \
    openssl \
    jpeg \
    zlib \
    freetype

# Copy language installations
COPY --from=builder /usr/lib/python3.12/site-packages /usr/lib/python3.12/site-packages
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /usr/lib/ruby/gems /usr/lib/ruby/gems
COPY --from=builder /usr/local/bin/bundle* /usr/local/bin/
COPY --from=builder /root/go /root/go
COPY --from=builder /root/.cargo /root/.cargo
COPY --from=builder /usr/local/lib/R /usr/local/lib/R

# Set environment variables
ENV JAVA_HOME=/usr/lib/jvm/java-11-openjdk
ENV GOPATH=/root/go
ENV PATH=$PATH:$GOPATH/bin:/root/.cargo/bin

# Final cleanup
RUN rm -rf /var/cache/apk/* /tmp/* /var/tmp/*

WORKDIR /app

# Copy the container source from the sandbox package
COPY ./node_modules/@cloudflare/sandbox/container_src .

EXPOSE 3000

CMD ["bun", "run", "index.ts"]