#!/bin/bash

echo "[Startup] Starting container server..."
echo "[Startup] Environment configured:"
echo "  - Working directory: $(pwd)"
echo "[Startup] Starting Bun server..."
exec bun dist/index.js
