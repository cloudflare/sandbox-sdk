import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const CLIENT_SECRET = 'executor-client-secret';
const WEBHOOK_SECRET = 'webhook-secret';

async function signedWebhook(event: unknown, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const webhookID = 'wh_1';
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${webhookID}.${timestamp}.${payload}`)
  );

  return new Request('https://executor.test/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': webhookID,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
    },
    body: payload
  });
}

const envelope = {
  id: 'evt_123',
  object: 'event',
  created_at: 1_750_287_018
} as const;

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

beforeEach(() => vi.unstubAllGlobals());

describe('Worker routes', () => {
  it('reports executor and webhook readiness', async () => {
    const response = await SELF.fetch('https://executor.test/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: 'openai-agents-api-executor',
      configured: true,
      webhook_configured: true
    });
  });

  it('reports an invalid keep-alive deadline as unconfigured', async () => {
    const response = await worker.fetch(
      new Request('https://executor.test/health'),
      {
        ...env,
        EXECUTOR_KEEP_ALIVE_SECONDS: '604801'
      } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ configured: false });
  });

  it('returns a server error when required webhook settings are missing', async () => {
    const response = await worker.fetch(
      new Request('https://executor.test/webhook', { method: 'POST' }),
      { ...env, OPENAI_WEBHOOK_SECRET: '' }
    );

    expect(response.status).toBe(503);
  });

  it('rejects non-POST webhook requests', async () => {
    const response = await SELF.fetch('https://executor.test/webhook');

    expect(response.status).toBe(405);
  });

  it('does not expose a programmatic executor start endpoint', async () => {
    const response = await SELF.fetch(
      'https://executor.test/executors/sess_1',
      {
        method: 'POST'
      }
    );

    expect(response.status).toBe(404);
  });

  it('destroys an executor for manual cleanup', async () => {
    const response = await SELF.fetch(
      'https://executor.test/executors/sess_1',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${CLIENT_SECRET}` }
      }
    );

    expect(response.status).toBe(204);
  });

  it('rejects an unauthorized manual cleanup request', async () => {
    const response = await SELF.fetch(
      'https://executor.test/executors/sess_1',
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer wrong-secret' }
      }
    );

    expect(response.status).toBe(401);
  });

  it('rejects an oversized webhook before signature verification', async () => {
    const response = await SELF.fetch('https://executor.test/webhook', {
      method: 'POST',
      body: 'x'.repeat(512 * 1024 + 1)
    });

    expect(response.status).toBe(413);
  });

  it('rejects an invalid webhook signature', async () => {
    const response = await SELF.fetch(
      await signedWebhook(actionRequiredEvent(), 'wrong-secret')
    );

    expect(response.status).toBe(400);
  });

  it('updates the session named by a signed webhook', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    );

    const response = await worker.fetch(
      await signedWebhook(actionRequiredEvent()),
      env
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/agents/sessions/sess_1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer controller-key' }
      })
    );
  });

  it('prewarms from a signed created event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    );

    const response = await worker.fetch(
      await signedWebhook({
        ...envelope,
        type: 'agent.session.created',
        data: {
          id: 'sess_1',
          environment_id: 'env_1',
          environment_type: 'self_hosted',
          connect: { remote_url: 'https://api.openai.test/v1' }
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['agent.session.in_progress', 'agent.session.idle'] as const)(
    'accepts a signed %s deadline event',
    async (type) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 404 }))
      );
      const response = await worker.fetch(
        await signedWebhook({
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
    }
  );

  it('ignores an unknown signed event type', async () => {
    const response = await SELF.fetch(
      await signedWebhook({
        ...envelope,
        type: 'agent.session.future_state',
        data: { id: 'sess_1' }
      })
    );

    expect(response.status).toBe(200);
  });
});
