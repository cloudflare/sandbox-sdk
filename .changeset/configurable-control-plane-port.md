---
"@cloudflare/sandbox": patch
"@repo/sandbox-container": patch
---

Make control plane port configurable via SANDBOX_CONTROL_PLANE_PORT environment variable

The SDK now supports configuring the control plane port (default: 3000) via the SANDBOX_CONTROL_PLANE_PORT environment variable. This allows users to avoid port conflicts when port 3000 is already in use by their application.

Additionally, improved error detection and logging for port conflicts. When the control plane port is already in use, the container will now provide clear error messages indicating the conflict and suggesting solutions.
