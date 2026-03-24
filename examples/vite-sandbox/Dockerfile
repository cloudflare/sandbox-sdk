FROM docker.io/cloudflare/sandbox:0.7.20

WORKDIR /app
COPY sandbox-app/package.json ./
RUN npm install
COPY sandbox-app/ ./

# Required during local development to access exposed ports
EXPOSE 5173
