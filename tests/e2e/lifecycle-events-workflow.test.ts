import { createHmac, randomUUID } from 'node:crypto';
import type { Process, SandboxLifecycleEvent } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import type { PortUnexposeResponse, WebhookReceipt } from './test-worker/types';

const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

async function listEvents(
  workerUrl: string,
  headers: Record<string, string>,
  options: {
    afterSeq?: number;
    limit?: number;
    types?: string[];
  } = {}
): Promise<SandboxLifecycleEvent[]> {
  const params = new URLSearchParams();

  if (options.afterSeq !== undefined) {
    params.set('afterSeq', String(options.afterSeq));
  }

  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }

  for (const type of options.types ?? []) {
    params.append('type', type);
  }

  const query = params.toString();
  const response = await fetch(
    `${workerUrl}/api/events${query ? `?${query}` : ''}`,
    {
      method: 'GET',
      headers
    }
  );

  expect(response.status).toBe(200);
  return (await response.json()) as SandboxLifecycleEvent[];
}

async function configureWebhooks(
  workerUrl: string,
  headers: Record<string, string>,
  webhooks: Array<{ url: string; secret: string; types?: string[] }>
) {
  const response = await fetch(`${workerUrl}/api/events/webhooks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ webhooks })
  });

  expect(response.status).toBe(200);
  return response.json();
}

async function resetWebhookReceipts(workerUrl: string, stream: string) {
  const response = await fetch(`${workerUrl}/test/webhook-events/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream })
  });

  expect(response.status).toBe(200);
}

async function listWebhookReceipts(
  workerUrl: string,
  stream: string
): Promise<WebhookReceipt[]> {
  const response = await fetch(
    `${workerUrl}/test/webhook-events?stream=${encodeURIComponent(stream)}`
  );

  expect(response.status).toBe(200);
  return (await response.json()) as WebhookReceipt[];
}

function computeSignature(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('Lifecycle Events Workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should replay sandbox startup events in sequence order', async () => {
    const events = await listEvents(workerUrl, headers);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.type).toBe('sandbox.created');
    expect(events[1]?.type).toBe('sandbox.started');
    expect(events[0]?.seq).toBeLessThan(events[1]?.seq ?? 0);

    const replay = await listEvents(workerUrl, headers, {
      afterSeq: events[0]?.seq,
      limit: 10
    });

    expect(replay[0]?.type).toBe('sandbox.started');
    expect(replay.every((event) => event.seq > (events[0]?.seq ?? 0))).toBe(
      true
    );
  }, 90000);

  test('should record process events and filter replay by type', async () => {
    const before = await listEvents(workerUrl, headers);
    const afterSeq = before.at(-1)?.seq ?? 0;

    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'sh -c "echo lifecycle && exit 0"'
      })
    });

    expect(startResponse.status).toBe(200);
    const process = (await startResponse.json()) as Process;
    expect(process.id).toBeTruthy();

    let processEvents: SandboxLifecycleEvent[] = [];
    await expect(
      (async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          processEvents = await listEvents(workerUrl, headers, {
            afterSeq,
            types: ['process.started', 'process.exited']
          });

          if (
            processEvents.some((event) => event.type === 'process.started') &&
            processEvents.some((event) => event.type === 'process.exited')
          ) {
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        throw new Error('Timed out waiting for process lifecycle events');
      })()
    ).resolves.toBeUndefined();

    expect(processEvents.map((event) => event.type)).toEqual([
      'process.started',
      'process.exited'
    ]);

    const started = processEvents[0];
    const exited = processEvents[1];

    expect(started).toMatchObject({
      type: 'process.started',
      processId: process.id,
      command: 'sh -c "echo lifecycle && exit 0"'
    });
    expect(exited).toMatchObject({
      type: 'process.exited',
      processId: process.id,
      exitCode: 0
    });
    expect((started?.seq ?? 0) < (exited?.seq ?? 0)).toBe(true);
  }, 90000);

  test('should record session lifecycle events', async () => {
    const before = await listEvents(workerUrl, headers);
    const afterSeq = before.at(-1)?.seq ?? 0;

    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'lifecycle-session',
        cwd: '/workspace'
      })
    });

    expect(createResponse.status).toBe(200);

    const deleteResponse = await fetch(`${workerUrl}/api/session/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: 'lifecycle-session' })
    });

    expect(deleteResponse.status).toBe(200);

    const events = await listEvents(workerUrl, headers, {
      afterSeq,
      types: ['session.created', 'session.deleted']
    });

    expect(events.map((event) => event.type)).toEqual([
      'session.created',
      'session.deleted'
    ]);
    expect(events[0]).toMatchObject({
      type: 'session.created',
      sessionId: 'lifecycle-session'
    });
    expect(events[1]).toMatchObject({
      type: 'session.deleted',
      sessionId: 'lifecycle-session'
    });
  }, 90000);

  test('should deliver signed lifecycle webhooks', async () => {
    const stream = `signed-${randomUUID()}`;
    const secret = 'webhook-secret';
    await resetWebhookReceipts(workerUrl, stream);

    await configureWebhooks(workerUrl, headers, [
      {
        url: `${workerUrl}/test/webhook-events?stream=${encodeURIComponent(stream)}`,
        secret,
        types: ['session.created']
      }
    ]);

    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: `webhook-session-${randomUUID()}` })
    });
    expect(createResponse.status).toBe(200);

    let receipts: WebhookReceipt[] = [];
    await expect(
      (async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          receipts = await listWebhookReceipts(workerUrl, stream);
          if (receipts.length > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error('Timed out waiting for webhook receipt');
      })()
    ).resolves.toBeUndefined();

    expect(receipts).toHaveLength(1);
    const payload = receipts[0]!.body;
    const parsed = JSON.parse(payload) as { event: SandboxLifecycleEvent };
    expect(parsed.event.type).toBe('session.created');
    expect(receipts[0]!.headers['x-sandbox-signature']).toBe(
      computeSignature(secret, payload)
    );
    expect(receipts[0]!.headers['x-sandbox-event-id']).toBe(parsed.event.id);
  }, 90000);

  test('should retry failed webhook deliveries', async () => {
    const stream = `retry-${randomUUID()}`;
    await resetWebhookReceipts(workerUrl, stream);

    await configureWebhooks(workerUrl, headers, [
      {
        url: `${workerUrl}/test/webhook-events?stream=${encodeURIComponent(stream)}&failFirst=true`,
        secret: 'retry-secret',
        types: ['session.created']
      }
    ]);

    const createResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: `retry-session-${randomUUID()}` })
    });
    expect(createResponse.status).toBe(200);

    let receipts: WebhookReceipt[] = [];
    await expect(
      (async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          receipts = await listWebhookReceipts(workerUrl, stream);
          if (receipts.length >= 2) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error('Timed out waiting for webhook retry');
      })()
    ).resolves.toBeUndefined();

    expect(receipts.length).toBeGreaterThanOrEqual(2);
    const eventIds = receipts.map(
      (receipt) =>
        (JSON.parse(receipt.body) as { event: SandboxLifecycleEvent }).event.id
    );
    expect(new Set(eventIds).size).toBe(1);
  }, 90000);

  test.skipIf(skipPortExposureTests)(
    'should record port exposure events with filtered replay',
    async () => {
      const before = await listEvents(workerUrl, headers);
      const afterSeq = before.at(-1)?.seq ?? 0;

      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          port: 8011,
          name: 'lifecycle-preview'
        })
      });

      expect(exposeResponse.status).toBe(200);
      const exposed = (await exposeResponse.json()) as {
        url: string;
        port: number;
        name?: string;
      };

      const unexposeResponse = await fetch(
        `${workerUrl}/api/exposed-ports/8011`,
        {
          method: 'DELETE',
          headers
        }
      );

      expect(unexposeResponse.status).toBe(200);
      const unexposed = (await unexposeResponse.json()) as PortUnexposeResponse;
      expect(unexposed.port).toBe(8011);

      const events = await listEvents(workerUrl, headers, {
        afterSeq,
        types: ['port.exposed', 'port.unexposed']
      });

      expect(events.map((event) => event.type)).toEqual([
        'port.exposed',
        'port.unexposed'
      ]);
      expect(events[0]).toMatchObject({
        type: 'port.exposed',
        port: 8011,
        name: 'lifecycle-preview',
        url: exposed.url
      });
      expect(events[1]).toMatchObject({
        type: 'port.unexposed',
        port: 8011
      });
    },
    90000
  );
});
