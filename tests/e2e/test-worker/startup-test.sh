#!/bin/bash
# Startup script for testing CMD passthrough
# This script runs as the CMD, proving the entrypoint forwards execution correctly

set -e

MARKER_FILE="/tmp/startup-marker.txt"
TIMESTAMP=$(date +%s)

# Write marker file with timestamp to prove execution
echo "startup-${TIMESTAMP}" > "${MARKER_FILE}"

# Log to stdout (can be verified in container logs)
echo "Startup script executed at ${TIMESTAMP}"
echo "Marker file written to ${MARKER_FILE}"

# Exit 0 - the sandbox server should continue running after this
exit 0
