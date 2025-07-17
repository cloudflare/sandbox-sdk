## @cloudflare/sandbox

> **⚠️ Experimental** - This library is currently experimental and we're actively seeking feedback. Please try it out and let us know what you think!

A library to spin up a sandboxed environment. **If you'd like to try one of our pre-made examples, take a look at [examples/basic](./examples/basic) ready to deploy to your Cloudflare account!**

First, create a Dockerfile at the root of your project, with the following content:

```Dockerfile
# If building your project on amd64, use:
FROM docker.io/ghostwriternr/cloudflare-sandbox:0.0.5
# If building your project on arm64, use:
# FROM docker.io/ghostwriternr/cloudflare-sandbox-arm:0.0.5

EXPOSE 3000

# Run the same command as the original image
CMD ["bun", "index.ts"]
```

> **NOTE**: In an upcoming release, this step will be removed entirely and you can reference a single Docker image published by us directly in your wrangler configuration below.

First, setup your wrangler.json to use the sandbox:

```jsonc
{
  // ...
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "max_instances": 1
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "class_name": "Sandbox",
        "name": "Sandbox"
      }
    ]
  },
  "migrations": [
    {
      "new_sqlite_classes": ["Sandbox"],
      "tag": "v1"
    }
  ]
}
```

Then, export the Sandbox class in your worker:

```ts
export { Sandbox } from "@cloudflare/sandbox";
```

You can then use the Sandbox class in your worker:

```ts
import { getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, "my-sandbox");
    return sandbox.exec("ls", ["-la"]);
  },
};
```

### Methods:

- `exec(command: string, args: string[], options?: { stream?: boolean })`: Execute a command in the sandbox.
- `gitCheckout(repoUrl: string, options: { branch?: string; targetDir?: string; stream?: boolean })`: Checkout a git repository in the sandbox.
- `mkdir(path: string, options: { recursive?: boolean; stream?: boolean })`: Create a directory in the sandbox.
- `writeFile(path: string, content: string, options: { encoding?: string; stream?: boolean })`: Write content to a file in the sandbox.
- `readFile(path: string, options: { encoding?: string; stream?: boolean })`: Read content from a file in the sandbox.
- `deleteFile(path: string, options?: { stream?: boolean })`: Delete a file from the sandbox.
- `renameFile(oldPath: string, newPath: string, options?: { stream?: boolean })`: Rename a file in the sandbox.
- `moveFile(sourcePath: string, destinationPath: string, options?: { stream?: boolean })`: Move a file from one location to another in the sandbox.
- `exposePort(port: number, options?: { name?: string })`: Expose a port for external access and get a preview URL. The hostname is automatically detected from the first request.
- `unexposePort(port: number)`: Remove port exposure.
- `getExposedPorts()`: List all currently exposed ports with their preview URLs.
- `ping()`: Ping the sandbox.

### Preview URLs

The Sandbox SDK now supports exposing ports from your containers to make them accessible via public preview URLs. This is useful for:
- Testing web applications running in the sandbox
- Exposing APIs or services for external access
- Debugging services running on specific ports

See [PREVIEW_URLS.md](./PREVIEW_URLS.md) for detailed documentation on this feature.
