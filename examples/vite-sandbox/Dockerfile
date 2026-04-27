FROM docker.io/cloudflare/sandbox:latest

WORKDIR /app
COPY sandbox-app/package.json ./
RUN npm install
COPY sandbox-app/ ./

# Documents the ports this application uses (standard Docker convention)
EXPOSE 5173
