#!/bin/bash

# Function to check if Jupyter is ready
check_jupyter_ready() {
  curl -s http://localhost:8888/api > /dev/null 2>&1
}

# Function to notify Bun server that Jupyter is ready
notify_jupyter_ready() {
  # Create a marker file that the Bun server can check
  touch /tmp/jupyter-ready
  echo "[Startup] Jupyter is ready, notified Bun server"
}

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
  --NotebookApp.allow_remote_access=True \
  --NotebookApp.allow_credentials=True \
  > /tmp/jupyter.log 2>&1 &

JUPYTER_PID=$!

# Start Bun server immediately (parallel startup)
echo "[Startup] Starting Bun server..."
bun index.ts &
BUN_PID=$!

# Monitor Jupyter readiness in background
(
  echo "[Startup] Monitoring Jupyter readiness in background..."
  MAX_ATTEMPTS=30
  ATTEMPT=0
  DELAY=0.5
  MAX_DELAY=5
  
  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if check_jupyter_ready; then
      notify_jupyter_ready
      echo "[Startup] Jupyter server is ready after $ATTEMPT attempts"
      break
    fi
    
    # Check if Jupyter process is still running
    if ! kill -0 $JUPYTER_PID 2>/dev/null; then
      echo "[Startup] WARNING: Jupyter process died. Check /tmp/jupyter.log for details"
      cat /tmp/jupyter.log
      # Don't exit - let Bun server continue running in degraded mode
      break
    fi
    
    ATTEMPT=$((ATTEMPT + 1))
    echo "[Startup] Jupyter not ready yet (attempt $ATTEMPT/$MAX_ATTEMPTS, delay ${DELAY}s)"
    
    # Sleep with exponential backoff
    sleep $DELAY
    
    # Increase delay exponentially with jitter, cap at MAX_DELAY
    DELAY=$(awk "BEGIN {printf \"%.2f\", $DELAY * 1.5 + (rand() * 0.5)}")
    # Use awk for comparison since bc might not be available
    if [ $(awk "BEGIN {print ($DELAY > $MAX_DELAY)}") -eq 1 ]; then
      DELAY=$MAX_DELAY
    fi
  done
  
  if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo "[Startup] WARNING: Jupyter failed to become ready within attempts"
    echo "[Startup] Jupyter logs:"
    cat /tmp/jupyter.log
    # Don't exit - let Bun server continue in degraded mode
  fi
) &

# Wait for Bun server (main process)
wait $BUN_PID