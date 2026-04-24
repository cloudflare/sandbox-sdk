FROM docker.io/cloudflare/sandbox:0.9.0

WORKDIR /app
COPY sandbox-app/package.json ./
RUN npm install
COPY sandbox-app/ ./

# Documents the ports this application uses (standard Docker convention)
EXPOSE 5173
