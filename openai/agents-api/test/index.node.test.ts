import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  resetSpanAttributes,
  spanAttributes
} from './mocks/cloudflare-workers';

const WEBHOOK_SECRET = 'webhook-secret';
const envelope = {
  id: 'evt_123',
  object: 'event',
  created_at: 1_750_287_018
} as const;

function signedWebhook(event: unknown): Request {
  const payload = JSON.stringify(event);
  const webhookID = 'wh_1';
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${webhookID}.${timestamp}.${payload}`)
    .digest('base64');

  return new Request('https://executor.test/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': webhookID,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`
    },
    body: payload
  });
}

function executorFixture(overrides: Record<string, string> = {}) {
  const executor = {
    prewarm: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined)
  };
  const getByName = vi.fn(() => executor);
  const env = {
    EXECUTORS: { getByName },
    OPENAI_EXECUTOR_API_KEY: 'executor-key',
    EXECUTOR_CLIENT_SECRET: 'client-secret',
    EXECUTOR_KEEP_ALIVE_SECONDS: '30',
    EXECUTOR_PREWARM_ENABLED: 'true',
    EXECUTOR_SNAPSHOTS_ENABLED: 'true',
    OPENAI_API_KEY: 'controller-key',
    OPENAI_AGENT_ID: 'agent_1',
    OPENAI_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides
  } as unknown as Env;
  return { env, executor, getByName };
}

function actionRequiredEvent() {
  return {
    ...envelope,
    type: 'agent.session.action_required',
    data: {
      id: 'sess_1',
      required_action: { type: 'environment_connection' }
    }
  };
}

function createdEvent() {
  return {
    ...envelope,
    type: 'agent.session.created',
    data: {
      id: 'sess_1',
      environment_id: 'env_1',
      environment_type: 'self_hosted',
      connect: { remote_url: 'https://api.openai.com/v1/agents/api' }
    }
  };
}

beforeEach(() => resetSpanAttributes());

describe('webhook routing', () => {
  it('records the caught error message on the failing span', async () => {
    const { env, executor } = executorFixture();
    executor.update.mockRejectedValueOnce(
      new Error('Container startup failed')
    );

    const response = await worker.fetch(
      signedWebhook(actionRequiredEvent()),
      env
    );

    expect(response.status).toBe(500);
    expect(spanAttributes).toContainEqual([
      'openai.webhook.type',
      'agent.session.action_required'
    ]);
    expect(spanAttributes).toContainEqual(['openai.webhook.data.id', 'sess_1']);
    expect(spanAttributes).toContainEqual(['error', true]);
    expect(spanAttributes).toContainEqual([
      'error.message',
      'Container startup failed'
    ]);
  });

  it('does not update an executor for a function-call action', async () => {
    const { env, executor } = executorFixture();

    const response = await worker.fetch(
      signedWebhook({
        ...envelope,
        type: 'agent.session.action_required',
        data: {
          id: 'sess_1',
          required_action: { type: 'function_call' }
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(executor.update).not.toHaveBeenCalled();
  });

  it('prewarms a self-hosted created event by default', async () => {
    const { env, executor } = executorFixture();

    const response = await worker.fetch(signedWebhook(createdEvent()), env);

    expect(response.status).toBe(200);
    expect(executor.prewarm).toHaveBeenCalledWith('sess_1');
    expect(executor.update).not.toHaveBeenCalled();
  });

  it('delegates created-event prewarming policy to the Durable Object', async () => {
    const { env, executor } = executorFixture();

    const response = await worker.fetch(signedWebhook(createdEvent()), env);

    expect(response.status).toBe(200);
    expect(executor.prewarm).toHaveBeenCalledWith('sess_1');
  });

  it.each(['agent.session.in_progress', 'agent.session.idle'] as const)(
    're-arms the deadline for %s',
    async (type) => {
      const { env, executor } = executorFixture();

      const response = await worker.fetch(
        signedWebhook({
          ...envelope,
          type,
          data: {
            id: 'sess_1',
            environment_id: 'env_1',
            environment_type: 'self_hosted'
          }
        }),
        env
      );

      expect(response.status).toBe(200);
      expect(executor.update).toHaveBeenCalledWith('sess_1');
    }
  );

  it('rejects a malformed supported event and traces the validation error', async () => {
    const { env, getByName } = executorFixture();

    const response = await worker.fetch(
      signedWebhook({
        ...envelope,
        type: 'agent.session.idle',
        data: { id: 'sess_1', environment_type: 'self_hosted' },
        created_at: 'invalid'
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(getByName).not.toHaveBeenCalled();
    expect(spanAttributes).toContainEqual(['error', true]);
    expect(
      spanAttributes.some(
        ([name, value]) =>
          name === 'error.message' && String(value).includes('created_at')
      )
    ).toBe(true);
  });

  it('acknowledges an unknown future event without creating a stub', async () => {
    const { env, getByName } = executorFixture();

    const response = await worker.fetch(
      signedWebhook({
        ...envelope,
        type: 'agent.session.future_state',
        data: { id: 'sess_1', secret: 'must-not-be-traced' }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(getByName).not.toHaveBeenCalled();
    expect(spanAttributes.flat()).not.toContain('must-not-be-traced');
  });
});
