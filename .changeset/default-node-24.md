---
'@cloudflare/sandbox': minor
---

Update the default sandbox image runtime from Node.js 20 to Node.js 24 so published images use the current Node.js LTS release. If your workload needs a different Node.js version, build a custom image with the `NODE_VERSION` Docker build argument.
