import { AgentAPISDK } from '@openai/agents-api-preview';
import { AgentsSessionManager } from './session-manager.js';
import type { SessionManager, SessionResult } from './types.js';

const DEMO_INITIAL_INPUT =
  'Use the shell to write basic-http-demo to /workspace/basic-demo.txt, then read it and reply with its exact contents.';
const DEMO_FOLLOW_UP_INPUT =
  'Read /workspace/basic-demo.txt and reply with its exact contents.';
const HEALTH_ROUTE = new URLPattern({ pathname: '/health' });
const DEMO_ROUTE = new URLPattern({ pathname: '/demo' });
const SESSIONS_ROUTE = new URLPattern({ pathname: '/sessions' });
const SESSION_INPUT_ROUTE = new URLPattern({
  pathname: '/sessions/:sessionID/input'
});
const SESSION_ROUTE = new URLPattern({ pathname: '/sessions/:sessionID' });

export function createHandler(
  manager: SessionManager
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && HEALTH_ROUTE.test(url)) {
        return Response.json({ ok: true });
      }

      if (request.method === 'POST' && DEMO_ROUTE.test(url)) {
        const initial = await manager.create(DEMO_INITIAL_INPUT);
        let followUp: SessionResult;
        try {
          followUp = await manager.run(initial.sessionID, DEMO_FOLLOW_UP_INPUT);
        } catch (error) {
          await manager.delete(initial.sessionID).catch(() => undefined);
          throw error;
        }
        await manager.delete(initial.sessionID);
        return Response.json({
          session_id: initial.sessionID,
          initial_output: initial.output,
          follow_up_output: followUp.output,
          cleaned_up: true
        });
      }

      if (request.method === 'POST' && SESSIONS_ROUTE.test(url)) {
        const input = await readInput(request);
        if (!input) return inputError();
        return sessionResponse(await manager.create(input), 201);
      }

      const inputMatch = SESSION_INPUT_ROUTE.exec(url);
      const inputSessionID = inputMatch?.pathname.groups.sessionID;
      if (request.method === 'POST' && inputSessionID) {
        const input = await readInput(request);
        if (!input) return inputError();
        return sessionResponse(
          await manager.run(decodeURIComponent(inputSessionID), input),
          200
        );
      }

      const sessionMatch = SESSION_ROUTE.exec(url);
      const sessionID = sessionMatch?.pathname.groups.sessionID;
      if (request.method === 'DELETE' && sessionID) {
        await manager.delete(decodeURIComponent(sessionID));
        return new Response(null, { status: 204 });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  };
}

export default {
  async fetch(request, env) {
    const client = new AgentAPISDK({ apiKey: env.OPENAI_API_KEY });
    const manager = new AgentsSessionManager(
      {
        agentID: env.OPENAI_AGENT_ID,
        executorClientSecret: env.EXECUTOR_CLIENT_SECRET,
        executorURL: env.EXECUTOR_URL.replace(/\/$/, ''),
        taskTimeoutMS:
          positiveInteger(env.TASK_TIMEOUT_SECONDS, 'TASK_TIMEOUT_SECONDS') *
          1_000
      },
      client
    );
    return createHandler(manager)(request);
  }
} satisfies ExportedHandler<Env>;

async function readInput(request: Request): Promise<string | undefined> {
  const value = (await request.json()) as unknown;
  if (typeof value !== 'object' || value === null || !('input' in value)) {
    return undefined;
  }
  const input = (value as { input?: unknown }).input;
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function inputError(): Response {
  return Response.json(
    { error: 'input must be a non-empty string' },
    { status: 400 }
  );
}

function sessionResponse(result: SessionResult, status: number): Response {
  return Response.json(
    { session_id: result.sessionID, output: result.output },
    { status }
  );
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
