## Overview

The Cloudflare Sandbox SDK lets you spin up secure, isolated code environments on the edge in milliseconds. Think of it as “serverless containers”: every sandbox is its own container with a filesystem, shell, package manager, and language runtime (Python, Node.js, Bun, etc.). 

You can exec commands, clone repos, start long-running services, expose them via public preview URLs, and run data science notebooks all without ever touching a server.

### Why build on Cloudflare Sandboxes? 
The Sandbox SDK runs on Cloudflare’s Durable Objects + Containers stack, so every sandbox launches quickly and executes close to your users worldwide.

You get:
- Low cold-start latency (Container cold starts can often be the 2-3 second range, but this is dependent on image size and other factors)
- Built-in state & scheduling (cron, retries)
- Preview URLs for any port you expose
- Edge-native security (each sandbox is its own PID namespace)
- Pay-for-what-you-use pricing—​containers spin down when idle


###  How it works? 
Under the hood, a Durable Object keeps the sandbox alive (state, env vars, open files). The SDK wraps that object with a friendly API: exec, startProcess, exposePort, runCode, gitClone, etc. 

You write zero infrastructure code, which is just JavaScript or TypeScript in a Worker. Deploy with wrangler deploy, and your sandbox is live.