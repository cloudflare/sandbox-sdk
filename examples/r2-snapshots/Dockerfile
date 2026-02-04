FROM cloudflare/sandbox-test:0.7.0

# Force new layer to push fresh code - timestamp: 2026-02-04T05:30
RUN echo "snapshot-v1" > /snapshot-version

# Required during local development to access exposed ports
EXPOSE 8080
