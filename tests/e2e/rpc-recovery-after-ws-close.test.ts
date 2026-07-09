/**
 * RPC transport — recovery after WebSocket failure.
 *
 * When several large writeFile calls land concurrently on the RPC
 * transport, the container-side proxy WebSocket inside containerFetch
 * fails and closes the proxied connection with code 1011 ("Container
 * WebSocket error"). Every in-flight RPC rejects with
 * `RPCTransportError: Peer closed WebSocket: 1011 ...`. That part is
 * fine — the calls are expected to fail.
 *
 * What is NOT fine: after that failure, every subsequent RPC on the
 * same Durable Object isolate also rejects with the same cached error
 * in <5 ms, because `DeferredTransport.#error` is sticky and recovery
 * is gated on a `setInterval` poller that doesn't fire while the
 * isolate is idle. The DO stays wedged until the runtime evicts it.
 *
 * This test reproduces the wedge: it fires a concurrent batch of
 * large writeFile calls, ignores their (expected) failures, then
 * issues a tiny `exec` and asserts it succeeds. On a healthy SDK the
 * DO recovers within a request or two; on the broken SDK every retry
 * returns the same 1011 error indefinitely.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

// Payload sized just under the 32 MiB JSRPC argument limit so the
// Worker → DO hop survives serialization and the pressure lands on the
// capnweb WebSocket between the DO and the container.
const PAYLOAD_SIZE_BYTES = 31 * 1024 * 1024;
const CONCURRENT_WRITES = 5;
const RECOVERY_ATTEMPTS = 5;
const RECOVERY_DELAY_MS = 500;

describe('RPC transport recovery after WebSocket failure', () => {
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

  test('DO recovers and serves subsequent requests after a concurrent writeFile batch closes the capnweb WebSocket with 1011', async () => {
    // Confirm baseline health before stressing the connection.
    const baseline = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/bash', '-lc', 'echo baseline'] })
    });
    expect(baseline.status).toBe(200);
    const baselineResult = (await baseline.json()) as CommandResponse;
    expect(baselineResult.stdout.trim()).toBe('baseline');

    // Build the payload once and reuse it across all concurrent
    // writes. Each request still serialises its own copy across
    // the Worker → DO RPC boundary, which is what we want.
    const payload = 'A'.repeat(PAYLOAD_SIZE_BYTES);

    // Fire the batch. We do NOT assert on individual outcomes —
    // any combination of success/failure is acceptable here.
    // The bug we're guarding against is that the *next* call
    // after the batch stays broken forever.
    const writes = Array.from({ length: CONCURRENT_WRITES }, (_, i) =>
      fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: sandbox!.uniquePath(`stress-${i}.bin`),
          content: payload
        })
      }).catch(() => undefined)
    );
    await Promise.all(writes);

    // Now probe with a tiny exec. The SDK should recover and
    // return a 200 within a handful of attempts. Pre-fix, every
    // attempt fails in ~1 ms with the cached 1011 error.
    let recoveredOn = -1;
    let lastStatus = 0;
    let lastBody = '';
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt++) {
      const probe = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'echo recovered']
        })
      });
      lastStatus = probe.status;
      lastBody = await probe.text();
      if (probe.status === 200) {
        const result = JSON.parse(lastBody) as CommandResponse;
        if (result.stdout.trim() === 'recovered') {
          recoveredOn = attempt;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, RECOVERY_DELAY_MS));
    }

    expect(
      recoveredOn,
      `DO did not recover within ${RECOVERY_ATTEMPTS} attempts. Last status: ${lastStatus}, last body: ${lastBody.slice(0, 500)}`
    ).toBeGreaterThanOrEqual(0);
  }, 120000);
});
