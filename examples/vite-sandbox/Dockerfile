FROM docker.io/cloudflare/sandbox:0.7.6

WORKDIR /app
COPY vite-app/package.json ./
RUN npm install
COPY vite-app/ ./

# Required during local development to access exposed ports
EXPOSE 5173
