import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type AgentAPISDK,
  asCurrentAgentSessionItem
} from '@openai/agents-api-preview';

const SESSION_SETTLE_RETRY_DELAY_MS = 250;

class TerminalSessionError extends Error {}

export async function runAgentTask(
  client: AgentAPISDK,
  sessionID: string,
  input: string,
  timeoutMS: number
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMS);
  const stream = await client.beta.agents.sessions.events
    .stream(sessionID, { stream: true }, { signal })
    .catch((error: unknown) => rethrowWithTimeout(error, signal, timeoutMS));
  let completedTurnID: string | undefined;

  try {
    await client.beta.agents.sessions.events.create(
      sessionID,
      {
        events: [
          {
            type: 'session.input.message',
            input: [
              {
                role: 'user',
                content: [{ type: 'input_text', text: input }]
              }
            ]
          }
        ],
        'Idempotency-Key': randomUUID()
      },
      { signal }
    );

    try {
      for await (const event of stream) {
        if (event.type === 'session.environment.failed') {
          throw new TerminalSessionError(
            event.environment.error?.message ?? 'The environment failed.'
          );
        }
        if (event.type === 'session.turn.failed') {
          throw new TerminalSessionError(
            event.turn.error?.message ?? 'The agent turn failed.'
          );
        }
        if (event.type === 'session.turn.cancelled') {
          throw new TerminalSessionError('The agent turn was cancelled.');
        }
        if (event.type === 'session.failed') {
          throw new TerminalSessionError(
            event.session.error ?? 'The agent session failed.'
          );
        }
        if (
          event.type === 'session.turn.completed' &&
          event.turn.subagent_id === null
        ) {
          completedTurnID = event.turn_id;
          break;
        }
      }
    } catch (error) {
      if (error instanceof TerminalSessionError) throw error;
    }
  } catch (error) {
    rethrowWithTimeout(error, signal, timeoutMS);
  } finally {
    stream.controller.abort();
  }

  try {
    await waitForSessionIdle(client, sessionID, signal);
    completedTurnID ??= await latestCompletedRootTurnID(
      client,
      sessionID,
      signal
    );
    return retainedOutput(client, sessionID, completedTurnID, signal);
  } catch (error) {
    rethrowWithTimeout(error, signal, timeoutMS);
  }
}

async function waitForSessionIdle(
  client: AgentAPISDK,
  sessionID: string,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    const session = await client.beta.agents.sessions.retrieve(sessionID, {
      signal
    });
    if (session.status === 'idle' && session.required_actions.length === 0) {
      return;
    }
    if (session.status === 'failed') {
      throw new Error(
        session.error ?? 'The agent session failed while settling.'
      );
    }
    await sleep(SESSION_SETTLE_RETRY_DELAY_MS, undefined, { signal });
  }
}

async function latestCompletedRootTurnID(
  client: AgentAPISDK,
  sessionID: string,
  signal: AbortSignal
): Promise<string> {
  for await (const turn of client.beta.agents.sessions.turns.list(
    sessionID,
    { limit: 100, order: 'desc' },
    { signal }
  )) {
    if (turn.subagent_id !== null) continue;
    if (turn.status === 'completed') return turn.id;
    if (turn.status === 'failed') {
      throw new Error(turn.error?.message ?? 'The agent turn failed.');
    }
    if (turn.status === 'cancelled') {
      throw new Error('The agent turn was cancelled.');
    }
  }
  throw new Error('The session became idle without a retained root turn.');
}

async function retainedOutput(
  client: AgentAPISDK,
  sessionID: string,
  turnID: string,
  signal: AbortSignal
): Promise<string> {
  const output: string[] = [];
  for await (const item of client.beta.agents.sessions.items.list(
    sessionID,
    { order: 'asc' },
    { signal }
  )) {
    if (item.turn_id !== turnID) continue;
    const current = asCurrentAgentSessionItem(item);
    if (
      current.type !== 'agent_message' &&
      (current.type !== 'message' || current.role !== 'assistant')
    ) {
      continue;
    }
    for (const content of current.content) {
      if (content.type === 'output_text') output.push(content.text);
    }
  }
  return output.join('');
}

function rethrowWithTimeout(
  error: unknown,
  signal: AbortSignal,
  timeoutMS: number
): never {
  if (signal.aborted && !(error instanceof TerminalSessionError)) {
    throw new Error(
      `Agent task did not complete within ${timeoutMS / 60_000} minutes.`,
      { cause: error }
    );
  }
  throw error;
}
