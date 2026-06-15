# GitHub Release Tooling

Release workflows keep orchestration in YAML and shared release mechanics in small scripts:

- `install-crane.sh` installs `crane` for image copying.
- `login-release-registries.sh` logs in to Docker Hub and the Cloudflare registry.
- `publish-sandbox-images.sh` copies sandbox image variants from the internal Cloudflare registry to public release tags.
- `release.yml` is the trusted-publishing entry point for stable and prerelease channels.
- `prerelease-channel.ts` computes and applies prerelease channel versions.

Run the targeted release-tooling tests when changing these scripts or release publishing workflow blocks:

```bash
npm run test:release-tools
```

These tests are a focused release-tooling check. The default `npm test` path stays scoped to workspace unit tests.
