# syntax=docker/dockerfile:1

FROM oven/bun:alpine AS builder

# Add build dependencies and Python
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
    jpeg-dev \
    zlib-dev \
    freetype-dev \
    lcms2-dev \
    openjpeg-dev \
    tiff-dev \
    harfbuzz-dev \
    fribidi-dev

# Install uv and comprehensive Python packages for data science and LLM tasks
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
RUN uv pip install --system --break-system-packages --no-cache --no-deps \
    # Essential data science core
    numpy pandas matplotlib scipy seaborn \
    # File processing essentials (important for LLM tasks)
    pillow openpyxl xlrd pyarrow \
    # Document generation (critical for LLM document tasks)
    fpdf pylatex reportlab PyPDF2 python-docx python-pptx \
    # Web and markup processing
    lxml jinja2 beautifulsoup4 \
    # Image processing
    imageio \
    # Utilities
    python-dateutil pytz tqdm joblib \
    # Math and validation
    sympy jsonschema \
    # Basic packages
    attrs six packaging && \
    # Install packages with dependencies (ML packages LLMs might request)
    uv pip install --system --break-system-packages --no-cache \
    scikit-learn plotly \
    # AI/ML frameworks (popular LLM requests)
    torch transformers datasets \
    # API clients for LLM integrations
    openai anthropic requests \
    # Jupyter for notebook execution
    jupyter ipykernel \
    # Database tools
    sqlalchemy \
    # Specialized tools
    contourpy tabulate pyparsing striprtf toolz && \
    # Aggressive cleanup
    find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true && \
    find /usr -type f -name "*.pyc" -delete && \
    find /usr -type f -name "*.pyo" -delete && \
    find /usr -type d -name "*.dist-info" -exec rm -rf {} + 2>/dev/null || true && \
    find /usr -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /usr -type d -name "test" -exec rm -rf {} + 2>/dev/null || true && \
    find /usr -name "*.so" -exec strip {} + 2>/dev/null || true

FROM oven/bun:alpine AS runtime

# Install minimal runtime dependencies using Alpine packages where possible
RUN apk add --no-cache \
    python3 \
    py3-pip \
    # Use Alpine packages for common libraries (smaller)
    py3-numpy \
    py3-pillow \
    # Runtime libs only
    jpeg zlib freetype lcms2 openjpeg tiff \
    harfbuzz fribidi \
    libffi openssl

# Copy only essential Python packages (skip Alpine-provided ones)
COPY --from=builder /usr/lib/python3.12/site-packages /usr/lib/python3.12/site-packages
COPY --from=builder /usr/bin/python* /usr/bin/

# Remove duplicates and unnecessary files in final stage
RUN find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true && \
    find /usr -type f -name "*.pyc" -delete && \
    rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/info/* && \
    rm -rf /var/cache/apk/* /tmp/* /var/tmp/*

WORKDIR /app

# Copy the container source from the sandbox package
COPY ./node_modules/@cloudflare/sandbox/container_src .

EXPOSE 3000

CMD ["bun", "run", "index.ts"]