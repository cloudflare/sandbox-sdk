# Docker Multi-Architecture Implementation Plan

## Problem Statement

Currently, the Sandbox SDK requires users to choose between architecture-specific Docker images:
- `ghostwriternr/cloudflare-sandbox:0.0.9` (AMD64)
- `ghostwriternr/cloudflare-sandbox-arm:0.0.9` (ARM64)

This creates user confusion, maintenance overhead, and inconsistent behavior across different systems.

## Root Cause Analysis

**Why this happens**: Docker containers share the host kernel, so binaries must match the host architecture. Our current approach uses the pre-2020 manual method of building separate images for each architecture.

**Current issues**:
1. Manual architecture-specific builds in `packages/sandbox/package.json`
2. User confusion about which image to use
3. No CI/CD automation for Docker builds
4. Maintenance overhead of managing multiple image variants
5. Architecture mismatches cause runtime failures

## Solution: Multi-Architecture Builds with Docker Buildx

Use Docker Buildx to create a single image tag containing variants for both ARM64 and AMD64 architectures.

## Implementation Plan

### Phase 1: Update Build Scripts
- [ ] Update `packages/sandbox/package.json` docker scripts to use buildx
- [ ] Replace architecture-specific tags with unified multi-arch build
- [ ] Test local multi-arch builds

**Commands to implement**:
```bash
# Replace current scripts with:
docker buildx build --platform linux/amd64,linux/arm64 -t ghostwriternr/cloudflare-sandbox:$npm_package_version --push .
```

### Phase 2: GitHub Actions CI/CD
- [ ] Add Docker build step to `.github/workflows/release.yml`
- [ ] Set up Docker Hub authentication with secrets
- [ ] Configure buildx with multi-platform support
- [ ] Ensure builds happen on release

**Required secrets**:
- `DOCKER_HUB_USERNAME`
- `DOCKER_HUB_ACCESS_TOKEN`

### Phase 3: Documentation Updates
- [ ] Update README.md to remove architecture selection guidance
- [ ] Simplify Dockerfile examples to use single image
- [ ] Update `examples/basic/Dockerfile` to use unified base image
- [ ] Remove references to `-arm` image variants

**Before**:
```dockerfile
FROM docker.io/ghostwriternr/cloudflare-sandbox:0.0.9
# If building your project on arm64, use:
# FROM docker.io/ghostwriternr/cloudflare-sandbox-arm:0.0.9
```

**After**:
```dockerfile
FROM docker.io/ghostwriternr/cloudflare-sandbox:0.0.9
```

### Phase 4: Testing & Validation
- [ ] Test multi-arch image on AMD64 system
- [ ] Test multi-arch image on ARM64 system (Mac M1/M2)
- [ ] Verify automatic architecture selection works
- [ ] Update examples and ensure they work on both architectures

### Phase 5: Cleanup
- [ ] Remove old architecture-specific images from Docker Hub
- [ ] Update any remaining documentation references
- [ ] Announce the change to users

## Technical Details

### Buildx Setup Requirements
- Docker Desktop 2.2+ (includes buildx)
- For Linux: enable QEMU for cross-compilation
- Multi-platform builder instance

### Performance Considerations
- QEMU emulation adds build time overhead
- Consider using native ARM64 runners for production builds
- Cross-compilation may be faster for simple applications

### Rollback Plan
If issues arise, we can:
1. Revert to manual architecture-specific builds
2. Keep both old and new images available during transition
3. Update documentation to reference working image variants

## Success Criteria

✅ Single Docker image tag works on both ARM64 and AMD64  
✅ Users no longer need to choose architecture-specific images  
✅ Automated builds in CI/CD  
✅ Documentation simplified and clear  
✅ All examples work on both architectures  

## Progress Tracking

- 🚧 **In Progress**: Creating implementation plan
- ⏳ **Pending**: Update build scripts
- ⏳ **Pending**: GitHub Actions integration
- ⏳ **Pending**: Documentation updates
- ⏳ **Pending**: Testing and validation