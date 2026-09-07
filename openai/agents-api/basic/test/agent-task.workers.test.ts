import type { AgentAPISDK } from '@openai/agents-api-preview';
import { describe, expect, it } from 'vitest';
import { runAgentTask } from '../src/agent-task.js';

async function* values<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

describe('runAgentTask', () => {
  it('ignores idle emitted before the submitted turn starts', async () => {
    const stream = values([
      { type: 'session.idle' },
      {
        type: 'session.turn.completed',
        turn_id: 'turn_1',
        turn: { subagent_id: null }
      }
    ]);
    Object.assign(stream, { controller: { abort() {} } });
    const client = {
      beta: {
        agents: {
          sessions: {
            retrieve: async () => ({
              status: 'idle',
              required_actions: []
            }),
            events: {
              stream: async () => stream,
              create: async () => undefined
            },
            turns: { list: () => values([]) },
            items: {
              list: () =>
                values([
                  {
                    id: 'message_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    phase: 'final_answer',
                    turn_id: 'turn_1',
                    content: [{ type: 'output_text', text: 'completed' }]
                  }
                ])
            }
          }
        }
      }
    } as unknown as AgentAPISDK;

    const output = await runAgentTask(client, 'sess_1', 'run', 30_000);

    expect(output).toBe('completed');
  });
});
