# Collaborative Terminal Dockerfile
#
# IMPORTANT: PTY support requires sandbox image version 0.7.0 or later.
#
# For local development with PTY support, first build the base image:
#   cd ../..  # Go to monorepo root  
#   docker build --platform linux/amd64 -f packages/sandbox/Dockerfile --target default -t sandbox-pty-local .
#
# The wrangler dev server will then use this Dockerfile which extends sandbox-pty-local.
#
FROM docker.io/cloudflare/sandbox:0.0.0-pr-310-ad66e85

# Create home directory for terminal sessions
RUN mkdir -p /home/user && chmod 777 /home/user

# Expose container port
EXPOSE 3000
