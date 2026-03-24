import { RpcTarget } from 'capnweb';
import type { Router } from '../core/router';

const BRIDGE_BASE_URL = 'http://localhost:3000';

/**
 * Bridge RpcTarget that translates capnweb RPC calls into HTTP requests
 * routed through the existing handler infrastructure.
 *
 * This is a transitional layer: capnweb clients call fetch() and
 * fetchStream() on this target, which constructs HTTP Request objects
 * and routes them through the container's Router. Later stages will
 * replace this bridge with direct service calls.
 */
export class ContainerBridgeAPI extends RpcTarget {
  #router: Router;

  constructor(router: Router) {
    super();
    this.#router = router;
  }

  async fetch(
    method: string,
    path: string,
    body?: string
  ): Promise<{
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }> {
    const url = `${BRIDGE_BASE_URL}${path}`;
    const request = new Request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body || undefined
    });

    const response = await this.#router.route(request);
    const responseBody = await response.text();

    return {
      status: response.status,
      body: responseBody || undefined,
      headers: Object.fromEntries(response.headers.entries())
    };
  }

  async fetchStream(
    method: string,
    path: string,
    body?: string
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${BRIDGE_BASE_URL}${path}`;
    const request = new Request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body || undefined
    });

    const response = await this.#router.route(request);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP error ${response.status}: ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return response.body;
  }
}
