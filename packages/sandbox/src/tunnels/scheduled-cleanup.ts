/**
 * Scheduled tunnel cleanup handler factory.
 *
 * Produces a Workers scheduled handler that runs `sweepStale` against
 * env-derived Cloudflare credentials. Workers with unrelated cron jobs
 * should call the returned handler from their own `controller.cron`
 * dispatch instead of asking the SDK to own that routing.
 *
 * ```ts
 * const tunnelCleanup = createScheduledTunnelCleanupHandler({
 *   staleAfterMs: 24 * 60 * 60_000
 * });
 *
 * export default {
 *   scheduled: tunnelCleanup
 * };
 * ```
 *
 * Credentials are read from `env` at handler-invocation time (when
 * secrets are populated). When `CLOUDFLARE_API_TOKEN` is missing the
 * sweep is skipped. Account and zone IDs are inferred from the token
 * when unambiguous; zone inference failures degrade to tunnel-only
 * cleanup.
 */

import { resolveAccountId, resolveZoneId } from './credentials';
import { type SweepOptions, type SweepResult, sweepStale } from './sweep';

/**
 * Subset of `ExecutionContext` the handler relies on. Matches the
 * Workers runtime shape without depending on `@cloudflare/workers-types`
 * at the SDK boundary, so the helper is portable to consumers using
 * looser type setups.
 */
interface ScheduledExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Loose `ScheduledController` shape matching the Workers scheduled handler fields we pass through. */
interface ScheduledControllerLike {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

type ScheduledHandler<Env extends object> = (
  controller: ScheduledControllerLike,
  env: Env,
  ctx: ScheduledExecutionContext
) => void | Promise<void>;

export interface ScheduledTunnelCleanupOptions extends Pick<
  SweepOptions,
  'staleAfterMs' | 'sandboxId' | 'dryRun'
> {
  /**
   * Override `fetch` used for Cloudflare API calls. Tests inject a
   * mock; production omits it.
   */
  fetcher?: typeof fetch;
  /**
   * Invoked when the sweep itself rejects (transport error, malformed
   * envelope, etc.). Per-resource failures already land in
   * `SweepResult.errors` and don't reach here. Default: `console.error`.
   */
  onError?: (err: unknown) => void | Promise<void>;
  /**
   * Invoked with each completed sweep's `SweepResult`. Default:
   * `console.log('tunnel sweep', JSON.stringify(result))`. Override to
   * pipe into a structured logger or alerting hook.
   */
  onResult?: (result: SweepResult) => void | Promise<void>;
}

/**
 * Env shape required by the handler. The handler degrades to a no-op
 * sweep when `CLOUDFLARE_API_TOKEN` is missing. Account and zone ids
 * may be set explicitly or inferred from the token when unambiguous.
 * Without a resolved zone ID, the sweep can delete stale tunnels but
 * skips DNS-record cleanup.
 */
interface ScheduledTunnelCleanupEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_TUNNEL_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
}

async function runTunnelCleanup(
  env: ScheduledTunnelCleanupEnv,
  opts: ScheduledTunnelCleanupOptions,
  onError: (err: unknown) => void | Promise<void>
): Promise<SweepResult | undefined> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) return undefined;

  const credentialEnv: Record<string, unknown> = {
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_TUNNEL_ACCOUNT_ID: env.CLOUDFLARE_TUNNEL_ACCOUNT_ID,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID
  };

  let accountId: string;
  try {
    accountId = await resolveAccountId(credentialEnv, {
      overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID',
      fetcher: opts.fetcher
    });
  } catch (err) {
    await onError(err);
    return undefined;
  }

  let zoneId: string | undefined;
  try {
    zoneId = await resolveZoneId(credentialEnv, {
      token,
      accountId,
      fetcher: opts.fetcher
    });
  } catch (err) {
    await onError(err);
  }

  return await sweepStale(
    {
      token,
      accountId,
      zoneId,
      fetcher: opts.fetcher
    },
    {
      staleAfterMs: opts.staleAfterMs,
      sandboxId: opts.sandboxId,
      dryRun: opts.dryRun
    }
  );
}

function readCleanupEnv(env: object): ScheduledTunnelCleanupEnv {
  return env as ScheduledTunnelCleanupEnv;
}

export function createScheduledTunnelCleanupHandler<
  Env extends object = object
>(opts: ScheduledTunnelCleanupOptions): ScheduledHandler<Env> {
  const onError =
    opts.onError ??
    ((err: unknown) => {
      console.error('tunnel sweep failed', err);
    });
  const onResult =
    opts.onResult ??
    ((result: SweepResult) => {
      console.log('tunnel sweep', JSON.stringify(result));
    });
  const reportError = async (err: unknown): Promise<void> => {
    try {
      await onError(err);
    } catch (handlerErr) {
      console.error('tunnel sweep error handler failed', handlerErr);
    }
  };
  const reportResult = async (result: SweepResult): Promise<void> => {
    try {
      await onResult(result);
    } catch (err) {
      await reportError(err);
    }
  };

  return async (_controller, env, ctx) => {
    const cleanupEnv = readCleanupEnv(env);
    if (!cleanupEnv.CLOUDFLARE_API_TOKEN) return;
    ctx.waitUntil(
      runTunnelCleanup(cleanupEnv, opts, reportError).then(async (result) => {
        if (result) await reportResult(result);
      }, reportError)
    );
  };
}
