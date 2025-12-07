import type { Sandbox } from '../sandbox';

export interface BridgeEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  SANDBOX_API_KEY: string;
}

export type BridgeOptions = {};
