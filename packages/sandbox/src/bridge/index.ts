// Convenience wrapper for zero-config deployments
export { createBridge } from './create-bridge';
export type { BridgeEnv, BridgeOptions } from './types';

// === Building Blocks for Power Users ===

export { proxyToSandbox } from '../request-handler';
// Re-export SDK essentials for convenience
// (Users can also import these from '@cloudflare/sandbox' directly)
export { getSandbox, Sandbox } from '../sandbox';
// Auth utilities
export { AuthError, createAuthErrorResponse, validateApiKey } from './auth';
// The core piece: HTTP request → Sandbox method translation
export { dispatchHandler } from './handlers';
// Route parsing
// CORS utilities
export {
  addCorsHeaders,
  handleCors,
  type ParsedRoute,
  parseRoute
} from './router';
