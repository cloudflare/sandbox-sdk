#!/bin/bash

echo "[Startup] Starting interpreter server..."
echo "[Startup] Process pool system initialized"

echo "[Startup] Environment configured:" 
echo "  - Working directory: $(pwd)"

# Start Bun server - the only process we need now
echo "[Startup] Starting Bun server..."
exec bun index.ts
