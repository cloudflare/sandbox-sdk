# Lifecycle Events

Lifecycle events let you observe sandbox state changes without polling process
status, port readiness, or ad-hoc side effects.

The current event model supports:

- sandbox lifecycle
- session lifecycle
- process lifecycle
- port exposure lifecycle
- replay with `afterSeq`
- optional webhook delivery with signed POST requests

## Event sources

A sandbox records events in Durable Object storage and exposes them through:

- `sandbox.listEvents()` for pull-based replay
- `sandbox.setEventWebhooks()` for push-based delivery

Each event includes:

- `id`
- `seq`
- `sandboxId`
- `timestamp`
- `type`
- event-specific fields such as `sessionId`, `processId`, `port`, or `url`

## Pull model: audit trail dashboard

Use `listEvents()` when you want to build a dashboard, timeline, or polling
consumer that can resume from the last known event.

```ts
const events = await sandbox.listEvents({
  afterSeq: 120,
  limit: 100,
  types: ['process.exited', 'port.exposed']
});
```

This pattern works well for:

- audit trail views
- operator consoles
- support debugging
- state recovery after a worker restart

## Push model: orchestration webhooks

Use webhook delivery when another service should react to state transitions.

```ts
await sandbox.setEventWebhooks([
  {
    url: 'https://example.com/hooks/sandbox',
    secret: env.WEBHOOK_SECRET,
    types: ['session.created', 'process.exited', 'port.exposed']
  }
]);
```

Webhook requests are delivered as JSON:

```json
{
  "event": {
    "id": "evt_123",
    "seq": 42,
    "sandboxId": "job-abc",
    "timestamp": "2026-03-22T12:34:56.000Z",
    "type": "process.exited",
    "processId": "proc_1",
    "exitCode": 0
  }
}
```

Headers include:

- `X-Sandbox-Event-Id`
- `X-Sandbox-Event-Seq`
- `X-Sandbox-Webhook-Id`
- `X-Sandbox-Signature`

The signature is an HMAC-SHA256 digest of the raw body:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifySignature(secret: string, body: string, signature: string) {
  const expected = `sha256=${createHmac('sha256', secret)
    .update(body)
    .digest('hex')}`;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Delivery is at-least-once. Consumers should dedupe by `event.id`.

## Example: orchestrating async jobs

A common pattern is to start background work and let a separate consumer react
when the sandbox reaches the next useful state.

```ts
const sandbox = getSandbox(env.Sandbox, `job-${jobId}`);

await sandbox.setEventWebhooks([
  {
    url: env.JOB_WEBHOOK_URL,
    secret: env.JOB_WEBHOOK_SECRET,
    types: ['process.exited', 'port.exposed']
  }
]);

const process = await sandbox.startProcess('npm run build');

return Response.json({
  accepted: true,
  processId: process.id
});
```

The webhook consumer can then:

- mark the job complete when `process.exited` succeeds
- mark it failed when `exitCode !== 0`
- publish preview URLs when `port.exposed` arrives

## Example: job runner with replay recovery

If you store the last seen sequence number in D1 or KV, you can resume event
consumption after a deployment or crash.

```ts
const lastSeq = await loadCheckpoint(jobId);
const events = await sandbox.listEvents({ afterSeq: lastSeq, limit: 100 });

for (const event of events) {
  await applyJobTransition(jobId, event);
  await saveCheckpoint(jobId, event.seq);
}
```

This is useful for:

- replaying missed webhooks
- rebuilding current state from the journal
- driving eventual-consistency workflows

## Example: audit trail dashboard

A dashboard worker can request the most recent lifecycle events and render a
simple timeline.

```ts
const events = await sandbox.listEvents({ limit: 50 });

return Response.json({
  sandboxId,
  timeline: events.map((event) => ({
    seq: event.seq,
    time: event.timestamp,
    type: event.type,
    details: event
  }))
});
```

## Recommended usage

- Use `listEvents()` when you need replay, auditing, or checkpoint-based state.
- Use webhooks when another service should react immediately.
- Use both when you want push delivery with replay as a recovery path.
