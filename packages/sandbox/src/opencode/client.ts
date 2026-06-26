import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeHandle } from './lifecycle';
import type { OpenCodeOptions } from './types';

type OpenCodeClientFactory = (options: {
  baseUrl: string;
  fetch: typeof fetch;
  directory?: string;
}) => OpencodeClient;

let createSDKClient: OpenCodeClientFactory | undefined;

async function loadSDK(): Promise<OpenCodeClientFactory> {
  if (createSDKClient) return createSDKClient;
  try {
    const sdk = await import('@opencode-ai/sdk/v2/client');
    createSDKClient = sdk.createOpencodeClient as OpenCodeClientFactory;
    return createSDKClient;
  } catch {
    throw new Error(
      '@opencode-ai/sdk is required for OpenCode integration. ' +
        'Install it with: npm install @opencode-ai/sdk'
    );
  }
}

/**
 * Build a typed OpenCode SDK client from a lifecycle handle.
 *
 * Works against either the Worker stub (`sandbox.opencode`) or the in-DO object
 * (`this.opencode`): it ensures the server through the handle, reads the stored
 * config, and routes every request through `handle.fetch`. Because the handle
 * owns `containerFetch`, this helper never touches sandbox transport directly.
 *
 * The SDK is imported lazily so the peer dependency is only required when an
 * OpenCode client is actually built.
 */
export async function createOpenCodeClient<TClient = OpencodeClient>(
  handle: OpenCodeHandle,
  options?: OpenCodeOptions
): Promise<TClient> {
  const server = await handle.start(options);
  const config = await handle.config();
  const directory = options?.directory ?? config.directory;

  const factory = await loadSDK();
  const client = factory({
    baseUrl: server.url,
    fetch: (input, init) => handle.fetch(new Request(input, init)),
    directory
  });

  return client as TClient;
}
