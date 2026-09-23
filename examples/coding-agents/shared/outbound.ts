import { WorkerEntrypoint } from "cloudflare:workers";

import type { CodingAgentEnv } from "./sandbox";

const GATEWAY_HOST = "gateway.ai.cloudflare.com";

// Every guest HTTP and HTTPS request reaches this entrypoint. Credentials stay in the Worker.
export class Outbound extends WorkerEntrypoint<CodingAgentEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === GATEWAY_HOST && this.#isGatewayPath(url.pathname)) {
      const headers = new Headers(request.headers);
      // Agents need a key to start; the gateway would forward a placeholder x-api-key to the provider.
      headers.delete("x-api-key");
      headers.set("cf-aig-authorization", `Bearer ${this.env.AI_GATEWAY_TOKEN}`);
      if (this.env.AI_GATEWAY_METADATA !== undefined) {
        headers.set("cf-aig-metadata", this.env.AI_GATEWAY_METADATA);
      }
      return fetch(new Request(request, { headers }));
    }
    if (url.hostname === "github.com") {
      if (this.env.GITHUB_TOKEN === undefined) return fetch(request);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Basic ${btoa(`x-access-token:${this.env.GITHUB_TOKEN}`)}`);
      return fetch(new Request(request, { headers }));
    }
    return new Response(`${url.hostname} is not reachable from this sandbox\n`, { status: 403 });
  }

  // The universal endpoint is the gateway path itself; provider routes sit below it.
  #isGatewayPath(pathname: string): boolean {
    const gatewayPath = `/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}`;
    return pathname === gatewayPath || pathname.startsWith(`${gatewayPath}/`);
  }
}
