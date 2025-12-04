# Base image Dockerfile (no Python)
# Used for testing Python-not-available error handling
FROM docker.io/cloudflare/sandbox-test:0.6.2

# Expose ports used for testing
# 8080: general testing
# 9998: reserved for process-lifecycle-workflow.test.ts
# 9999: reserved for websocket-workflow.test.ts
EXPOSE 8080 9998 9999
