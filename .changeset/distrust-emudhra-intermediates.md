---
'@cloudflare/sandbox': patch
---

Stop trusting certificates from the compromised eMudhra intermediate CAs in the container images. The images now ship the updated Ubuntu and Alpine CA bundles, Node.js 22.23.4, cloudflared 2026.10.2, and pip 26.2.2 in the `-python` image. Bun keeps trusting these certificates until it releases a fix, which affects `bun`, opencode, and multipart uploads in `createBackup()` for archives of 10 MiB or more. Update the container image to get this fix. See [the eMudhra certificate compromise](https://blog.cloudflare.com/emudhra-certificate-compromise/) for details.
