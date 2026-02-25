---
'@cloudflare/sandbox': patch
---

Add desktop environment support for AI computer-use workflows.

Start a full Linux desktop (Xvfb + XFCE4 + x11vnc + noVNC) inside the
sandbox and control it programmatically via `sandbox.desktop.*` methods.
Supports screenshots, mouse clicks, keyboard input, and live browser
streaming via noVNC preview URLs.

Enable with `sandbox.desktop.start()`. Requires the desktop container
image variant.
