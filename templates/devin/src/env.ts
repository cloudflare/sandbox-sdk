import type { DevinSession } from "./session";

export interface Env {
  DEVIN_SESSION: DurableObjectNamespace<DevinSession>;
  DEVIN_OUTPOST_ID: string;
  DEVIN_API_TOKEN: string;
  DEVIN_API_URL: string;
  WORKER_ID_PREFIX: string;
  DEVIN_RECONCILE_INTERVAL_MS: string;
}
