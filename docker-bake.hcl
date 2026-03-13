// docker-bake.hcl — Declarative multi-image build configuration
// All sandbox image variants built in a single `bake` invocation.
// Bake builds targets in parallel, deduplicates shared base stages.
//
// Usage:
//   TAG=pr-42 SANDBOX_VERSION=0.1.0 docker buildx bake main
//   CACHE_REPO=ghcr.io/org/repo/cache TAG=main docker buildx bake main

variable "TAG" { default = "dev" }
variable "SANDBOX_VERSION" { default = "dev" }
variable "BUN_VERSION" { default = "1.3" }
variable "BUILD_INTERNAL_SERVER_PORT" { default = "8671" }
variable "CACHE_REPO" { default = "" }

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
  args       = { SANDBOX_VERSION = SANDBOX_VERSION, BUN_VERSION = BUN_VERSION, BUILD_INTERNAL_SERVER_PORT = BUILD_INTERNAL_SERVER_PORT }
}

target "default" {
  inherits   = ["_common"]
  target     = "default"
  tags       = ["sandbox:${TAG}"]
  cache-from = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:default"] : []
  cache-to   = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:default,mode=max"] : []
}

target "python" {
  inherits   = ["_common"]
  target     = "python"
  tags       = ["sandbox-python:${TAG}"]
  cache-from = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:python"] : []
  cache-to   = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:python,mode=max"] : []
}

target "opencode" {
  inherits   = ["_common"]
  target     = "opencode"
  tags       = ["sandbox-opencode:${TAG}"]
  cache-from = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:opencode"] : []
  cache-to   = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:opencode,mode=max"] : []
}

target "musl" {
  inherits   = ["_common"]
  target     = "musl"
  tags       = ["sandbox-musl:${TAG}"]
  cache-from = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:musl"] : []
  cache-to   = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:musl,mode=max"] : []
}

target "desktop" {
  inherits   = ["_common"]
  target     = "desktop"
  tags       = ["sandbox-desktop:${TAG}"]
  cache-from = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:desktop"] : []
  cache-to   = CACHE_REPO != "" ? ["type=registry,ref=${CACHE_REPO}:desktop,mode=max"] : []
}
