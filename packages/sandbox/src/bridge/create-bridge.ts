import type { BridgeEnv, BridgeOptions } from './types';

export function createBridge(
  _options?: BridgeOptions
): ExportedHandler<BridgeEnv> {
  return {
    async fetch(_request: Request, _env: BridgeEnv, _ctx: ExecutionContext) {
      return new Response('Bridge not implemented yet', { status: 501 });
    }
  };
}
