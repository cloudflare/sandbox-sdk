/**
 * Public entry point for `@cloudflare/sandbox/tunnels`.
 *
 * Account-wide tunnel-resource helpers. Kept off the main entry point
 * (and off the `Sandbox` DO surface) so per-sandbox callers don't
 * accidentally reach for sweep primitives that operate on everything
 * the token can see.
 *
 * Typical usage from a cron-triggered Worker:
 *
 * ```ts
 * import { sweepStale } from '@cloudflare/sandbox/tunnels';
 *
 * await sweepStale(
 *   { token, accountId, zoneId },
 *   { staleAfterMs: 24 * 60 * 60_000 }
 * );
 * ```
 *
 * The `createScheduledTunnelCleanupHandler` helper is the zero-boilerplate
 * way to wire the sweep into a Cron Trigger.
 */

export {
  type CloudflareCredentials,
  type DNSSummary,
  listSandboxDNSRecords,
  listSandboxTunnels,
  type TunnelSummary
} from './inventory';
export {
  createScheduledTunnelCleanupHandler,
  type ScheduledTunnelCleanupOptions
} from './scheduled-cleanup';
export { type SweepOptions, type SweepResult, sweepStale } from './sweep';
