import type { ISandbox } from '@repo/shared';

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface SandboxClient extends ISandbox {
  readonly id: string;
}
