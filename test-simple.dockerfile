# Test dockerfile with minimal Python setup
FROM oven/bun:alpine

RUN apk add --no-cache python3 py3-pip

WORKDIR /app
COPY ./node_modules/@cloudflare/sandbox/container_src .

CMD ["python3", "-c", "import sys; print(f'Python {sys.version} + Bun ready!')"]