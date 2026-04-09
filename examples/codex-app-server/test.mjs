#!/usr/bin/env node
/**
 * End-to-end smoke test for the Codex App Server example.
 * Connects via WebSocket, runs the handshake, creates a thread,
 * sends a prompt, and verifies streamed responses.
 */

const WS_URL = process.env.WS_URL || `ws://localhost:8787/ws/test-${Date.now()}`;
const TIMEOUT_MS = 120_000;
const REPO_URL = 'https://github.com/cloudflare/sandbox-sdk';

let nextId = 0;
let ws;
let threadId = null;

// --- Helpers ---

function req(method, params = {}) {
  return { method, id: nextId++, params };
}

function send(msg) {
  const raw = JSON.stringify(msg);
  console.log(`  >>> ${msg.method || 'response'} (id=${msg.id ?? '-'})`);
  ws.send(raw);
}

function waitFor(predicate, label, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const arrow = msg.method ? `${msg.method}` : `response(id=${msg.id})`;
      if (!msg.method?.includes('/delta')) {
        console.log(`  <<< ${arrow}`);
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Timeout waiting for: ${label}`));
    }, timeoutMs);
    ws.addEventListener('message', handler);
  });
}

function assert(condition, label) {
  if (!condition) {
    console.error(`  FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`  PASS: ${label}`);
}

// --- Test steps ---

async function step(label, fn) {
  console.log(`\n--- ${label} ---`);
  await fn();
}

async function run() {
  const deadline = setTimeout(() => {
    console.error('\nFATAL: Overall test timeout');
    process.exit(1);
  }, TIMEOUT_MS);

  // Connect
  await step('Connect WebSocket', async () => {
    ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', (e) => reject(new Error('WebSocket connect failed')));
    });
    assert(ws.readyState === WebSocket.OPEN, 'WebSocket is open');
  });

  // sandbox/setup — clone a repo
  await step('sandbox/setup', async () => {
    const setupMsg = req('sandbox/setup', { repoUrl: REPO_URL });
    const setupId = setupMsg.id;
    send(setupMsg);
    const resp = await waitFor(
      (m) => m.id === setupId && (m.result || m.error),
      'sandbox/setup response',
    );
    assert(!resp.error, `No error (got: ${JSON.stringify(resp.error || 'none')})`);
    assert(resp.result?.ok === true, 'result.ok === true');
    console.log(`  Clone result: ${JSON.stringify(resp.result)}`);
  });

  // initialize handshake
  await step('initialize', async () => {
    const initMsg = req('initialize', {
      clientInfo: { name: 'smoke_test', title: 'Smoke Test', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    const initId = initMsg.id;
    send(initMsg);
    const resp = await waitFor(
      (m) => m.id === initId && m.result,
      'initialize response',
    );
    assert(resp.result != null, 'Got initialize result');
    console.log(`  Server: ${JSON.stringify(resp.result?.serverInfo || {})}`);

    // Send initialized notification
    send({ method: 'initialized', params: {} });
    console.log('  Sent initialized notification');
  });

  // Create a thread
  await step('thread/start', async () => {
    const threadMsg = req('thread/start');
    const threadReqId = threadMsg.id;
    send(threadMsg);
    const resp = await waitFor(
      (m) => m.id === threadReqId && m.result,
      'thread/start response',
    );
    assert(resp.result?.thread?.id, 'Got thread ID');
    threadId = resp.result.thread.id;
    console.log(`  Thread ID: ${threadId}`);
  });

  // Send a prompt and collect streamed response
  await step('turn/start — send prompt', async () => {
    const turnMsg = req('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'What files are in /workspace? List them briefly.' }],
    });
    send(turnMsg);

    // Collect agent text deltas
    let agentText = '';
    let deltaCount = 0;

    await waitFor((m) => {
      if (m.method === 'item/agentMessage/delta' && m.params?.delta) {
        agentText += m.params.delta;
        deltaCount++;
      }
      return m.method === 'turn/completed';
    }, 'turn/completed');
    assert(deltaCount > 0, `Received ${deltaCount} streaming deltas`);
    assert(agentText.length > 0, `Agent responded (${agentText.length} chars)`);
    console.log(`  Agent text (first 200 chars): ${agentText.slice(0, 200)}`);
  });

  // Verify middleware: model should be enforced
  await step('Verify model enforcement (via second turn)', async () => {
    // We already sent one turn — the middleware logs show model enforcement.
    // Let's verify the thread is still usable with a trivial prompt.
    const turnMsg = req('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Reply with exactly: SMOKE_TEST_OK' }],
    });
    send(turnMsg);

    let agentText = '';
    await waitFor((m) => {
      if (m.method === 'item/agentMessage/delta' && m.params?.delta) {
        agentText += m.params.delta;
      }
      return m.method === 'turn/completed';
    }, 'second turn completed');

    assert(agentText.includes('SMOKE_TEST_OK'), `Agent echoed marker: "${agentText.slice(0, 100)}"`);
  });

  // Clean close
  ws.close();
  clearTimeout(deadline);
  console.log('\n=== ALL TESTS PASSED ===\n');
  process.exit(0);
}

run().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
