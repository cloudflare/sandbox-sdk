#!/bin/bash

# Start Jupyter notebook server in background
echo "[Startup] Starting Jupyter server..."
jupyter notebook \
  --ip=0.0.0.0 \
  --port=8888 \
  --no-browser \
  --allow-root \
  --NotebookApp.token='' \
  --NotebookApp.password='' \
  --NotebookApp.allow_origin='*' \
  --NotebookApp.disable_check_xsrf=True \
  > /tmp/jupyter.log 2>&1 &

JUPYTER_PID=$!

# Wait for Jupyter to be ready
echo "[Startup] Waiting for Jupyter to become ready..."
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  if curl -s http://localhost:8888/api > /dev/null 2>&1; then
    echo "[Startup] Jupyter server is ready!"
    break
  fi
  
  # Check if Jupyter process is still running
  if ! kill -0 $JUPYTER_PID 2>/dev/null; then
    echo "[Startup] ERROR: Jupyter process died. Check /tmp/jupyter.log for details"
    cat /tmp/jupyter.log
    exit 1
  fi
  
  ATTEMPT=$((ATTEMPT + 1))
  echo "[Startup] Waiting for Jupyter... (attempt $ATTEMPT/$MAX_ATTEMPTS)"
  sleep 1
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
  echo "[Startup] ERROR: Jupyter failed to start within 30 seconds"
  echo "[Startup] Jupyter logs:"
  cat /tmp/jupyter.log
  exit 1
fi

# Start the main Bun server
echo "[Startup] Starting Bun server..."
exec bun index.ts