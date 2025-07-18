import { Container, getContainer } from "@cloudflare/containers";
import { HttpClient } from "./client";
import { isLocalhostPattern } from "./request-handler";

export function getSandbox(ns: DurableObjectNamespace<Sandbox>, id: string) {
  const stub = getContainer(ns, id);

  // Store the name on first access - this is a fire-and-forget operation
  stub.setSandboxName?.(id).catch(() => {
    // Ignore errors - this is best effort
  });

  return stub;
}

export class Sandbox<Env = unknown> extends Container<Env> {
  sleepAfter = "3m"; // Sleep the sandbox if no requests are made in this timeframe
  client: HttpClient;
  private workerHostname: string | null = null;
  private sandboxName: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.client = new HttpClient({
      onCommandComplete: (success, exitCode, _stdout, _stderr, command, _args) => {
        console.log(
          `[Container] Command completed: ${command}, Success: ${success}, Exit code: ${exitCode}`
        );
      },
      onCommandStart: (command, args) => {
        console.log(
          `[Container] Command started: ${command} ${args.join(" ")}`
        );
      },
      onError: (error, _command, _args) => {
        console.error(`[Container] Command error: ${error}`);
      },
      onOutput: (stream, data, _command) => {
        console.log(`[Container] [${stream}] ${data}`);
      },
      port: 3000, // Control plane port
      stub: this,
    });

    // Load the sandbox name from storage on initialization
    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName = await this.ctx.storage.get<string>('sandboxName') || null;
    });
  }

  envVars = {
    MESSAGE: "I was passed in via the Sandbox class!",
  };

  // RPC method to set the sandbox name
  async setSandboxName(name: string): Promise<void> {
    if (!this.sandboxName) {
      this.sandboxName = name;
      await this.ctx.storage.put('sandboxName', name);
      console.log(`[Sandbox] Stored sandbox name via RPC: ${name}`);
    }
  }

  override onStart() {
    console.log("Sandbox successfully started");
  }

  override onStop() {
    console.log("Sandbox successfully shut down");
    if (this.client) {
      this.client.clearSession();
    }
  }

  override onError(error: unknown) {
    console.log("Sandbox error:", error);
  }

  // Override fetch to capture the hostname and route to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Capture the hostname from the first request
    if (!this.workerHostname) {
      this.workerHostname = url.hostname;
      console.log(`[Sandbox] Captured hostname: ${this.workerHostname}`);
    }

    // Capture and store the sandbox name from the header if present
    if (!this.sandboxName && request.headers.has('X-Sandbox-Name')) {
      const name = request.headers.get('X-Sandbox-Name')!;
      this.sandboxName = name;
      await this.ctx.storage.put('sandboxName', name);
      console.log(`[Sandbox] Stored sandbox name: ${this.sandboxName}`);
    }

    // Determine which port to route to
    const port = this.determinePort(url);

    // Route to the appropriate port
    return await this.containerFetch(request, port);
  }

  private determinePort(url: URL): number {
    // Extract port from proxy requests (e.g., /proxy/8080/*)
    const proxyMatch = url.pathname.match(/^\/proxy\/(\d+)/);
    if (proxyMatch) {
      return parseInt(proxyMatch[1]);
    }

    // All other requests go to control plane on port 3000
    // This includes /api/* endpoints and any other control requests
    return 3000;
  }

  async exec(command: string, args: string[], options?: { stream?: boolean; background?: boolean }) {
    if (options?.stream) {
      return this.client.executeStream(command, args, undefined, options?.background);
    }
    return this.client.execute(command, args, undefined, options?.background);
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string; stream?: boolean }
  ) {
    if (options?.stream) {
      return this.client.gitCheckoutStream(
        repoUrl,
        options.branch,
        options.targetDir
      );
    }
    return this.client.gitCheckout(repoUrl, options.branch, options.targetDir);
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.mkdirStream(path, options.recursive);
    }
    return this.client.mkdir(path, options.recursive);
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string; stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.writeFileStream(path, content, options.encoding);
    }
    return this.client.writeFile(path, content, options.encoding);
  }

  async deleteFile(path: string, options: { stream?: boolean } = {}) {
    if (options?.stream) {
      return this.client.deleteFileStream(path);
    }
    return this.client.deleteFile(path);
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    options: { stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.renameFileStream(oldPath, newPath);
    }
    return this.client.renameFile(oldPath, newPath);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    options: { stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.moveFileStream(sourcePath, destinationPath);
    }
    return this.client.moveFile(sourcePath, destinationPath);
  }

  async readFile(
    path: string,
    options: { encoding?: string; stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.readFileStream(path, options.encoding);
    }
    return this.client.readFile(path, options.encoding);
  }

  async exposePort(port: number, options?: { name?: string }) {
    await this.client.exposePort(port, options?.name);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    const hostname = this.getHostname();
    const url = this.constructPreviewUrl(port, this.sandboxName, hostname);

    return {
      url,
      port,
      name: options?.name,
    };
  }

  async unexposePort(port: number) {
    await this.client.unexposePort(port);
  }

  async getExposedPorts() {
    const response = await this.client.getExposedPorts();

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    const hostname = this.getHostname();

    return response.ports.map(port => ({
      url: this.constructPreviewUrl(port.port, this.sandboxName!, hostname),
      port: port.port,
      name: port.name,
      exposedAt: port.exposedAt,
    }));
  }

  private getHostname(): string {
    // Use the captured hostname or fall back to localhost for development
    return this.workerHostname || "localhost:8787";
  }

  private constructPreviewUrl(port: number, sandboxId: string, hostname: string): string {
    // Check if this is a localhost pattern
    const isLocalhost = isLocalhostPattern(hostname);

    if (isLocalhost) {
      // For local development, we need to use a different approach
      // Since subdomains don't work with localhost, we'll use the base URL
      // with a note that the user needs to handle routing differently
      return `http://${hostname}/preview/${port}/${sandboxId}`;
    }

    // For all other domains (workers.dev, custom domains, etc.)
    // Use subdomain-based routing pattern
    const protocol = hostname.includes(":") ? "http" : "https";
    return `${protocol}://${port}-${sandboxId}.${hostname}`;
  }
}
