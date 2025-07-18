import { Container, getContainer } from "@cloudflare/containers";
import { HttpClient } from "./client";
import { isLocalhostPattern } from "./request-handler";

export function getSandbox(ns: DurableObjectNamespace<Sandbox>, id: string) {
  return getContainer(ns, id);
}

export class Sandbox<Env = unknown> extends Container<Env> {
  defaultPort = 3000; // The default port for the container to listen on
  sleepAfter = "3m"; // Sleep the sandbox if no requests are made in this timeframe
  client: HttpClient;
  private workerHostname: string | null = null;

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
      port: this.defaultPort,
      stub: this,
    });
  }

  envVars = {
    MESSAGE: "I was passed in via the Sandbox class!",
  };

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

  // Override fetch to capture the hostname
  override async fetch(request: Request): Promise<Response> {
    // Capture the hostname from the first request
    if (!this.workerHostname) {
      const url = new URL(request.url);
      this.workerHostname = url.hostname;
      console.log(`[Sandbox] Captured hostname: ${this.workerHostname}`);
    }

    // Call the parent fetch method
    return super.fetch(request);
  }

  async exec(command: string, args: string[], options?: { stream?: boolean }) {
    if (options?.stream) {
      return this.client.executeStream(command, args);
    }
    return this.client.execute(command, args);
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
    const response = await this.client.exposePort(port, options?.name);

    // Get the current domain from the captured hostname
    const sandboxId = this.ctx.id.toString();
    const hostname = this.getHostname();

    // Construct the preview URL based on the hostname
    const url = this.constructPreviewUrl(port, sandboxId, hostname);

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

    // Transform the response to include preview URLs
    const sandboxId = this.ctx.id.toString();
    const hostname = this.getHostname();

    return response.ports.map(port => ({
      url: this.constructPreviewUrl(port.port, sandboxId, hostname),
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
