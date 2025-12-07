import type { ClientOptions, SandboxClient } from './types';

export function getSandbox(
  _id: string,
  _options?: ClientOptions
): SandboxClient {
  throw new Error('Client SDK not implemented yet');
}
