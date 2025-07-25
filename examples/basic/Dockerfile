# This image is unique to this repo, and you'll never need it.
# Whenever you're integrating with sandbox SDK in your own project,
# you should use the official image instead:
# FROM docker.io/ghostwriternr/cloudflare-sandbox:0.1.1
FROM ghostwriternr/cloudflare-sandbox-test:0.1.1

EXPOSE 8080
EXPOSE 3001

# Run the same command as the original image
CMD ["bun", "index.ts"]
