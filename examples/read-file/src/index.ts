import { Sandbox } from "@cloudflare/sandbox";

interface Env {
  SANDBOX: DurableObjectNamespace<ReadFileSandbox>;
  SANDBOX_IMAGE: string;
}

export class ReadFileSandbox extends Sandbox<Env> {
  async read(path: string): Promise<Response> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }

    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
      });
    }

    return this.files.readFile(path);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "/fixture.txt";
    const id = env.SANDBOX.idFromName("read-file-example");
    return env.SANDBOX.get(id).read(path);
  },
} satisfies ExportedHandler<Env>;
