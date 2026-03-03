// docker-bake.hcl — Declarative multi-image build configuration
// All sandbox image variants built in a single `bake` invocation.
// Bake builds targets in parallel, deduplicates shared base stages.
//
// Usage:
//   TAG=pr-42 SANDBOX_VERSION=0.1.0 CF_REGISTRY=registry.cloudflare.com/<id> docker buildx bake main
//   TAG=main  SANDBOX_VERSION=0.1.0 CF_REGISTRY=registry.cloudflare.com/<id> docker buildx bake main

variable "TAG" { default = "dev" }
variable "SANDBOX_VERSION" { default = "dev" }
variable "CF_REGISTRY" { default = "" }

// main: all variants needed for E2E testing (CF registry)
group "main" {
  targets = ["default", "python", "opencode", "musl", "desktop"]
}

// publish: variants published to Docker Hub (standalone excluded — CF registry only)
group "publish" {
  targets = ["default", "python", "opencode", "musl", "desktop"]
}

target "_common" {
  context    = "."
  dockerfile = "packages/sandbox/Dockerfile"
  platforms  = ["linux/amd64"]
  args       = { SANDBOX_VERSION = SANDBOX_VERSION }
  cache-from = [CF_REGISTRY != "" ? "type=registry,ref=${CF_REGISTRY}/cache:buildcache" : ""]
  cache-to   = [CF_REGISTRY != "" ? "type=registry,ref=${CF_REGISTRY}/cache:buildcache,mode=max" : ""]
}

target "default" {
  inherits = ["_common"]
  target   = "default"
  tags     = ["sandbox:${TAG}"]
}

target "python" {
  inherits = ["_common"]
  target   = "python"
  tags     = ["sandbox-python:${TAG}"]
}

target "opencode" {
  inherits = ["_common"]
  target   = "opencode"
  tags     = ["sandbox-opencode:${TAG}"]
}

target "musl" {
  inherits = ["_common"]
  target   = "musl"
  tags     = ["sandbox-musl:${TAG}"]
}

target "desktop" {
  inherits = ["_common"]
  target   = "desktop"
  tags     = ["sandbox-desktop:${TAG}"]
}
