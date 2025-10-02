## Getting Started

Get a sandbox running on Cloudflare’s edge in under two minutes.

#### Prerequisites

| Requirement        | Why it matters          
| ------------- |:-------------:  
| A Cloudflare account | Billing enables Workers, Durable Objects, and Containers. 
| Docker (local dev only) | Required until we auto-pull the base image.


#### 1. Install the SDK
```
npm install @cloudflare/sandbox
```

#### 2. Add a temporary Dockerfile
> NOTE: temporary requirement, will be removed in future releases
```
FROM docker.io/cloudflare/sandbox:0.3.0
EXPOSE 3000        # any ports your app will bind
```
#### 3. Configure wrangler.json
> NOTE: In an upcoming release, this step will be removed entirely and you can reference a single Docker image published by us directly in your wrangler configuration below.
```
{
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "max_instances": 1
    }
  ],
  "durable_objects": {
    "bindings": [
      { "class_name": "Sandbox", "name": "Sandbox" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Sandbox"] }
  ]
}
```

#### 4. Create your Worker:

```
import { getSandbox } from "@cloudflare/sandbox";

// Export the Sandbox class in your Worker
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, "my-sandbox");

    // Execute a command
    const result = await sandbox.exec("echo 'Hello from the edge!'");
    return new Response(result.stdout);
  },
};
```
