# Base image Dockerfile (no Python)
# Used for testing Python-not-available error handling
FROM docker.io/cloudflare/sandbox-test:0.7.4

# Expose ports used for testing
# 8080: general testing
# 9090: process-readiness-workflow.test.ts (waitForPort test)
# 9091: process-readiness-workflow.test.ts (chained waitForLog/Port test)
# 9092: process-readiness-workflow.test.ts (port exposure test)
# 9093: process-readiness-workflow.test.ts (custom token port exposure test)
# 9998: reserved for process-lifecycle-workflow.test.ts
# 9999: reserved for websocket-workflow.test.ts
EXPOSE 8080 9090 9091 9092 9093 9998 9999
