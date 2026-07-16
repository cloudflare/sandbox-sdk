import { tracing } from 'cloudflare:workers';
import {
  acceptorId,
  type DevinSessionSummary,
  type SessionCommand,
  sessionCommand
} from './lifecycle';

async function getDevin<T>(env: Env, path: string): Promise<T> {
  return tracing.enterSpan('devin.api.request', async (span) => {
    span.setAttribute('http.request.method', 'GET');
    span.setAttribute('devin.api.path', path);

    const response = await fetch(`${env.DEVIN_API_URL}/opbeta${path}`, {
      headers: { Authorization: `Bearer ${env.DEVIN_API_TOKEN}` },
      signal: AbortSignal.timeout(30_000)
    });
    span.setAttribute('http.response.status_code', response.status);

    if (!response.ok) {
      span.setAttribute('error', true);
      throw Object.assign(
        new Error(`Devin API ${response.status}: ${await response.text()}`),
        { status: response.status }
      );
    }
    return (await response.json()) as T;
  });
}

interface DevinSessionPage {
  items: DevinSessionSummary[];
  cursor?: string | null;
  has_next_page?: boolean;
}

export async function fetchSessions(
  env: Env
): Promise<{ items: DevinSessionSummary[] }> {
  const pool = encodeURIComponent(env.DEVIN_POOL_ID);
  const items: DevinSessionSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await getDevin<DevinSessionPage>(
      env,
      `/outposts/devins?pool=${pool}${suffix}`
    );
    items.push(...page.items);

    if (!page.has_next_page) break;
    if (!page.cursor) throw new Error('Devin API omitted the next-page cursor');
    if (seenCursors.has(page.cursor))
      throw new Error('Devin API returned a repeated pagination cursor');
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  return { items };
}

export interface ReconcileResult {
  scanned: number;
  ensured: number;
  stopped: number;
  ignored: number;
  errors: string[];
}

export async function reconcileSession(
  env: Env,
  entry: DevinSessionSummary
): Promise<SessionCommand> {
  const sessionId = entry.metadata.session_id;
  const poolId = entry.metadata.pool_id;
  const rawStatus = entry.status?.session_status ?? null;
  const command = sessionCommand(rawStatus);

  if (command === 'ignore') {
    console.warn(
      `[${sessionId}] unhandled session_status=${JSON.stringify(rawStatus)} phase=${JSON.stringify(entry.status?.phase ?? null)}`
    );
    return command;
  }

  const stub = env.DevinWorker.get(env.DevinWorker.idFromName(sessionId));
  if (command === 'ensureRunning') {
    await stub.ensureRunning(
      sessionId,
      poolId,
      acceptorId(env.WORKER_ID_PREFIX, sessionId)
    );
    return command;
  }

  await stub.stop(sessionId, rawStatus ?? 'unknown');
  return command;
}

/**
 * Reconcile Devin's documented Outposts session statuses into explicit
 * container commands:
 *
 *   pending/running       -> ensure the session's container is running
 *   suspended/terminated  -> notify the session's container controller
 *
 * Unknown/missing statuses are logged and ignored. The DO does not call Devin;
 * it only acts as the per-session Cloudflare Container controller.
 */
export async function reconcile(env: Env): Promise<ReconcileResult> {
  return tracing.enterSpan('reconcile', async (span) => {
    const result: ReconcileResult = {
      scanned: 0,
      ensured: 0,
      stopped: 0,
      ignored: 0,
      errors: []
    };

    if (!env.DEVIN_POOL_ID) {
      result.errors.push('DEVIN_POOL_ID is not set');
      span.setAttribute('error', true);
      return result;
    }
    if (!env.DEVIN_API_TOKEN) {
      result.errors.push('DEVIN_API_TOKEN is not set');
      span.setAttribute('error', true);
      return result;
    }
    if (!env.DEVIN_API_URL) {
      result.errors.push('DEVIN_API_URL is not set');
      span.setAttribute('error', true);
      return result;
    }

    const { items } = await fetchSessions(env);
    result.scanned = items.length;
    span.setAttribute('devin.reconcile.scanned', items.length);

    for (const entry of items) {
      const sessionId = entry.metadata.session_id;
      const rawStatus = entry.status?.session_status ?? null;

      await tracing.enterSpan('reconcile.session', async (sessionSpan) => {
        sessionSpan.setAttribute('devin.session_id', sessionId);
        sessionSpan.setAttribute('devin.session_status', rawStatus ?? 'null');
        if (entry.status?.phase != null)
          sessionSpan.setAttribute('devin.phase', entry.status.phase);

        try {
          const command = await reconcileSession(env, entry);
          sessionSpan.setAttribute('devin.container.command', command);
          if (command === 'ensureRunning') result.ensured++;
          else if (command === 'stop') result.stopped++;
          else result.ignored++;
        } catch (err) {
          result.errors.push(`[${sessionId}] reconcile failed: ${err}`);
          console.error(`[${sessionId}] reconcile failed`, err);
          sessionSpan.setAttribute('error', true);
        }
      });
    }

    span.setAttribute('devin.reconcile.ensured', result.ensured);
    span.setAttribute('devin.reconcile.stopped', result.stopped);
    span.setAttribute('devin.reconcile.ignored', result.ignored);
    span.setAttribute('devin.reconcile.errors', result.errors.length);
    return result;
  });
}
