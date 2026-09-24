import { listOutpostSessions, type OutpostSession } from "./devin-api";
import type { Env } from "./env";
import { describeError } from "./session";

export { DevinSession } from "./session";

// Matches the cron trigger in wrangler.jsonc. Polls stay inside this window so runs never overlap.
const SCHEDULE_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 10_000;

type SessionCommand = "ensureRunning" | "suspend" | "terminate";

// Devin's documented session statuses. Anything else is logged and left alone.
const SESSION_COMMANDS = new Map<string, SessionCommand>([
  ["pending", "ensureRunning"],
  ["running", "ensureRunning"],
  ["suspended", "suspend"],
  ["terminated", "terminate"],
]);

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ service: "devin-outpost", status: "ok" });
  },

  async scheduled(_controller, env): Promise<void> {
    const intervalMs = reconcileIntervalMs(env);
    const deadline = Date.now() + SCHEDULE_INTERVAL_MS;

    await reconcile(env);
    // Start another poll only if it can finish before the next cron run.
    while (Date.now() + intervalMs < deadline) {
      await scheduler.wait(intervalMs);
      await reconcile(env);
    }
  },
} satisfies ExportedHandler<Env>;

async function reconcile(env: Env): Promise<void> {
  const required = {
    DEVIN_OUTPOST_ID: env.DEVIN_OUTPOST_ID,
    DEVIN_API_TOKEN: env.DEVIN_API_TOKEN,
    DEVIN_API_URL: env.DEVIN_API_URL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value === "" || value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    console.error({ event: "devin.reconcile.misconfigured", missing });
    return;
  }

  let sessions: OutpostSession[];
  try {
    sessions = await listOutpostSessions(env);
  } catch (cause) {
    console.error({ event: "devin.reconcile.failed", error: describeError(cause) });
    return;
  }

  const counts = { scanned: sessions.length, ignored: 0, failed: 0 };
  for (const session of sessions) {
    const sessionId = session.metadata.session_id;
    const status = session.status?.session_status ?? undefined;
    try {
      await reconcileSession(env, session, sessionId, status);
    } catch (cause) {
      counts.failed++;
      console.error({
        event: "devin.session.failed",
        sessionId,
        status,
        error: describeError(cause),
      });
    }
  }
  console.log({ event: "devin.reconcile", ...counts });
}

async function reconcileSession(
  env: Env,
  session: OutpostSession,
  sessionId: string,
  status: string | undefined,
): Promise<void> {
  // Only act on sessions that Devin assigned to this outpost.
  if (session.metadata.outpost_id !== env.DEVIN_OUTPOST_ID) {
    console.warn({
      event: "devin.session.foreign",
      sessionId,
      outpostId: session.metadata.outpost_id,
    });
    return;
  }
  const command = status === undefined ? undefined : SESSION_COMMANDS.get(status);
  if (command === undefined) {
    console.warn({
      event: "devin.session.unknown_status",
      sessionId,
      status,
      phase: session.status?.phase,
    });
    return;
  }

  const stub = env.DEVIN_SESSION.getByName(sessionId);
  if (command === "ensureRunning") {
    await stub.ensureRunning(sessionId, `${env.WORKER_ID_PREFIX || "cf-outpost"}-${sessionId}`);
  } else if (command === "suspend") {
    await stub.suspend(sessionId);
  } else {
    await stub.terminate(sessionId);
  }
}

function reconcileIntervalMs(env: Env): number {
  const parsed = Number(env.DEVIN_RECONCILE_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECONCILE_INTERVAL_MS;
}
