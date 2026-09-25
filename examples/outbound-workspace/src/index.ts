import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { decide, type HandlerName, OutboundRules } from "./rules.js";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const RULES_KEY = "outbound-rules";
const COMMAND_TIMEOUT_MS = 60_000;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// HTTPS interception re-signs traffic with a Containers CA. exec() does not inherit the
// environment from start(), so pass this on every command that makes HTTPS requests.
const TRUST_ENV = { CURL_CA_BUNDLE: CA_PATH, SSL_CERT_FILE: CA_PATH, NODE_EXTRA_CA_CERTS: CA_PATH };

const CommandRequest = z.object({ argv: z.array(z.string()).min(1) });

interface Env {
  SANDBOX: DurableObjectNamespace<OutboundSandbox>;
  // Optional. The bearer-token handler sends it to the hosts it handles.
  UPSTREAM_TOKEN?: string;
}

interface OutboundProps {
  sandboxName: string;
}

interface OutboundSandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    readonly Outbound: LoopbackForExport<typeof Outbound>;
  };
}

// Every HTTP request on port 80 and HTTPS request on port 443 reaches this entrypoint. It reads the
// current rules on each request, so a rule change applies to the next request.
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rules = await this.env.SANDBOX.getByName(this.ctx.props.sandboxName).outboundRules();
    const decision = decide(rules, url.hostname);
    if (decision.action === "deny") return new Response(`${decision.reason}\n`, { status: 403 });
    if (decision.action === "fetch") return fetch(request);
    return this.#handle(decision.handler, request, url);
  }

  #handle(handler: HandlerName, request: Request, url: URL): Promise<Response> | Response {
    if (handler === "audit") {
      console.log({ event: "outbound.audit", method: request.method, url: request.url });
      return fetch(request);
    }
    // Credentials stay in the Worker. The Container never sees the token. The Worker fetches with
    // the guest's scheme, so a token added to plain HTTP would cross the Internet unencrypted.
    if (url.protocol !== "https:") {
      return new Response("bearer-token sends its token only over HTTPS\n", { status: 403 });
    }
    if (this.env.UPSTREAM_TOKEN === undefined) {
      return new Response("UPSTREAM_TOKEN is not set\n", { status: 500 });
    }
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${this.env.UPSTREAM_TOKEN}`);
    return fetch(new Request(request, { headers }));
  }
}

export class OutboundSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #exports: OutboundSandboxState["exports"];

  constructor(ctx: OutboundSandboxState, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#exports = ctx.exports;
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  // Rules live in Durable Object storage, so they outlast the Container and apply to the next one.
  outboundRules(): OutboundRules {
    return OutboundRules.parse(this.ctx.storage.kv.get(RULES_KEY) ?? {});
  }

  setOutboundRules(rules: OutboundRules): OutboundRules {
    this.ctx.storage.kv.put(RULES_KEY, rules);
    return rules;
  }

  async run(
    sandboxName: string,
    argv: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.#ensureExecution(sandboxName);
    // Not AbortSignal.timeout(): it stays armed after the command exits, and signalling an
    // exited process logs an internal error. Clear the timer instead.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), COMMAND_TIMEOUT_MS);
    try {
      const process = await this.#container.exec(argv, {
        cwd: "/workspace",
        env: TRUST_ENV,
        signal: abort.signal,
      });
      const output = await process.output();
      const decoder = new TextDecoder();
      return {
        exitCode: output.exitCode,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async resetExecution(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  async #ensureExecution(sandboxName: string): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "lite",
      // Only HTTP on port 80 and HTTPS on port 443 leave the Container, through the intercepts
      // below. Connections to other ports time out. With enableInternet: true, they would go out
      // directly and skip the rules.
      enableInternet: false,
      labels: { example: "outbound-workspace", sandbox: sandboxName },
    });
    // Intercepts last for this Container run. The rules can change without installing them again.
    const outbound = this.#exports.Outbound({ props: { sandboxName } });
    await this.#container.interceptAllOutboundHttp(outbound);
    await this.#container.interceptOutboundHttps("*", outbound);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/sandboxes\/([^/]+)\/(outbound-rules|commands|execution)$/.exec(url.pathname);
    if (match === null) return new Response("Not found", { status: 404 });
    const [, sandboxName, resource] = match;
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      if (resource === "outbound-rules" && request.method === "GET") {
        return Response.json(await sandbox.outboundRules());
      }
      if (resource === "outbound-rules" && request.method === "PUT") {
        const rules = await parseBody(request, OutboundRules);
        return Response.json(await sandbox.setOutboundRules(rules));
      }
      if (resource === "commands" && request.method === "POST") {
        const { argv } = await parseBody(request, CommandRequest);
        return Response.json(await sandbox.run(sandboxName, argv));
      }
      if (resource === "execution" && request.method === "DELETE") {
        await sandbox.resetExecution();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      if (cause instanceof z.ZodError) return new Response(z.prettifyError(cause), { status: 400 });
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        resource,
        error: describeError(cause),
      });
      return new Response("Sandbox request failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) throw new Error("Container attachment is unavailable");
  return container;
}

// A body that is not JSON fails validation with 400, like any other bad body, instead of a 500.
async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await request.json().catch(() => undefined));
}

// Structured logs drop an Error's message and stack because they are not enumerable.
function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}
