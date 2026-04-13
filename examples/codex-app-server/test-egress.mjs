#!/usr/bin/env node
/**
 * Validates egress networking constraints for the Codex App Server.
 *
 * Connects via WebSocket, completes the Codex handshake, then uses
 * sandbox/exec to make HTTP requests from inside the container and
 * verifies:
 *   - api.openai.com  → allowed, API key injected by the egress proxy
 *   - github.com       → allowed (passthrough)
 *   - everything else  → blocked with 403
 */

const WS_URL =
  process.env.WS_URL ||
  `ws://localhost:8787/ws/egress-test-${Date.now()}`;
const TIMEOUT_MS = 120_000;

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

function waitForResponse(id, label) {
  return waitFor(
    (m) => m.id === id && (m.result !== undefined || m.error !== undefined),
    label,
  );
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (!condition) {
    console.error(`  FAIL: ${label}`);
    failed++;
  } else {
    console.log(`  PASS: ${label}`);
    passed++;
  }
}

async function step(label, fn) {
  console.log(`\n--- ${label} ---`);
  await fn();
}

/** Run a shell command inside the sandbox via sandbox/exec. */
async function sandboxExec(command) {
  const msg = req('sandbox/exec', { command });
  send(msg);
  const resp = await waitForResponse(msg.id, `sandbox/exec: ${command.slice(0, 60)}`);
  if (resp.error) throw new Error(`sandbox/exec error: ${resp.error.message}`);
  return resp.result;
}

// --- Main ---

async function run() {
  const deadline = setTimeout(() => {
    console.error('\nFATAL: Overall test timeout');
    process.exit(1);
  }, TIMEOUT_MS);

  // 1. Connect
  await step('Connect WebSocket', async () => {
    ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('WebSocket connect failed')));
    });
    assert(ws.readyState === WebSocket.OPEN, 'WebSocket is open');
  });

  // 2. Initialize handshake
  await step('Initialize', async () => {
    const initMsg = req('initialize', {
      clientInfo: { name: 'egress_test', title: 'Egress Test', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    send(initMsg);
    const resp = await waitForResponse(initMsg.id, 'initialize response');
    assert(!resp.error, 'Initialize succeeded');

    send({ method: 'initialized', params: {} });
  });

  // 3. Start thread
  await step('Start thread', async () => {
    const threadMsg = req('thread/start');
    send(threadMsg);
    const resp = await waitForResponse(threadMsg.id, 'thread/start response');
    assert(resp.result?.thread?.id, 'Got thread ID');
    threadId = resp.result.thread.id;
    console.log(`  Thread ID: ${threadId}`);
  });

  // 4. Egress tests via sandbox/exec
  // All requests use curl from inside the container. The egress proxy only
  // intercepts HTTP (not HTTPS), so we use http:// URLs. The proxy upgrades
  // api.openai.com to HTTPS and injects the API key.

  await step('Egress: api.openai.com — should be ALLOWED with API key injection', async () => {
    // Hit the models endpoint via HTTP — the egress proxy upgrades to HTTPS
    // and injects the real API key. The container only has a dummy key.
    const result = await sandboxExec(
      'curl -s -o /dev/null -w "%{http_code}" http://api.openai.com/v1/models'
    );
    const stdout = (result.stdout || result.output || '').trim();
    assert(stdout === '200', `api.openai.com returned HTTP 200 (got: ${stdout})`);
  });

  await step('Egress: api.openai.com API key injection — container should NOT have real key', async () => {
    // The container receives a dummy OPENAI_API_KEY via setEnvVars.
    const result = await sandboxExec('echo $OPENAI_API_KEY');
    const stdout = (result.stdout || result.output || '').trim();
    assert(
      stdout === 'proxy-injected',
      `OPENAI_API_KEY is dummy value (got: "${stdout.slice(0, 40)}")`,
    );
  });

  await step('Egress: api.openai.com API key injection — verify key is injected', async () => {
    // Make a real API call that requires auth — list models
    const result = await sandboxExec(
      'curl -s http://api.openai.com/v1/models | head -c 200'
    );
    const stdout = (result.stdout || result.output || '').trim();
    // Should get JSON with model data, not an auth error
    assert(!stdout.includes('invalid_api_key'), 'Response is not an auth error');
    assert(stdout.startsWith('{'), `Response is JSON (starts with: "${stdout.slice(0, 30)}")`);
  });

  await step('Egress: github.com — should be ALLOWED', async () => {
    const result = await sandboxExec(
      'curl -s -o /dev/null -w "%{http_code}" http://github.com/'
    );
    const stdout = (result.stdout || result.output || '').trim();
    // github.com over HTTP redirects to HTTPS (301/302), which means the
    // egress proxy allowed it through. Any 3xx or 200 counts as success.
    const code = parseInt(stdout, 10);
    assert(code >= 200 && code < 400, `github.com returned HTTP ${code} (allowed)`);
  });

  await step('Egress: example.com — should be BLOCKED (403)', async () => {
    const result = await sandboxExec(
      'curl -s -o /dev/null -w "%{http_code}" http://example.com/'
    );
    const stdout = (result.stdout || result.output || '').trim();
    assert(stdout === '403', `example.com returned HTTP 403 (got: ${stdout})`);
  });

  await step('Egress: httpbin.org — should be BLOCKED (403)', async () => {
    const result = await sandboxExec(
      'curl -s -o /dev/null -w "%{http_code}" http://httpbin.org/get'
    );
    const stdout = (result.stdout || result.output || '').trim();
    assert(stdout === '403', `httpbin.org returned HTTP 403 (got: ${stdout})`);
  });

  await step('Egress: blocked response body', async () => {
    const result = await sandboxExec('curl -s http://example.com/');
    const stdout = (result.stdout || result.output || '').trim();
    assert(
      stdout.includes('Forbidden by egress policy'),
      `Blocked response contains "Forbidden by egress policy" (got: "${stdout.slice(0, 80)}")`,
    );
  });

  // Summary
  ws.close();
  clearTimeout(deadline);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
