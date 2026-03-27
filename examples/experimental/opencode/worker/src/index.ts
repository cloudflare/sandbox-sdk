/**
 * OpenCode on Cloudflare — with sandboxed code execution
 *
 * Two Sandbox containers:
 *   OPENCODE — runs `opencode serve` with the sandbox plugin
 *   SANDBOX  — isolated code execution (one instance per session)
 *
 * The OpenCodeSandbox DO handles all persistent state:
 *   - Starts opencode serve
 *   - Establishes Cap'n Web WebSocket to the plugin
 *   - Exposes SandboxRpcApi so tool calls route to per-session CodeSandbox instances
 */

import { switchPort } from '@cloudflare/containers';
import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import {
  createOpencodeServer,
  proxyToOpencode
} from '@cloudflare/sandbox/opencode';
import type { Config } from '@opencode-ai/sdk/v2';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';

export { ContainerProxy } from '@cloudflare/containers';

const BRIDGE_PORT = 3001;

// ── Config ───────────────────────────────────────────────────────

const getConfig = (env: Env): Config => ({
  provider: {
    openai: {
      options: { apiKey: env.OPENAI_API_KEY }
    }
  }
});

// ── Sandbox RPC target ───────────────────────────────────────────

/**
 * Exposed to the plugin inside the OpenCode container via Cap'n Web.
 * Each method takes a sessionId to route to the correct CodeSandbox instance.
 */
class SandboxRpcApi extends RpcTarget {
  #env: Env;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  async sandbox(sessionId: string) {
    return getSandbox(this.#env.SANDBOX, `session-${sessionId}`);
  }
}

// ── OpenCodeSandbox DO ───────────────────────────────────────────

/**
 * Sandbox subclass that runs OpenCode and manages the Cap'n Web bridge.
 * All persistent WebSocket / RPC state lives here in the DO, not in the Worker.
 */
export class OpenCodeSandbox extends Sandbox<Env> {
  private bridgeConnected = false;
  requiredPorts = [BRIDGE_PORT];

  override async onStart() {
    super.onStart();
    console.log('[opencode-do] container started, connecting bridge');
    this.connectBridge().catch((err) =>
      console.error('[bridge] connection failed:', err)
    );
  }

  public async waitUntilReady(): Promise<void> {
    await this.waitForPort({ portToCheck: BRIDGE_PORT, waitInterval: 1000 });
  }

  /**
   * Connect to the plugin's WebSocket server and establish Cap'n Web RPC.
   * Runs inside the DO so the WebSocket persists across Worker requests.
   */
  private async connectBridge() {
    if (this.bridgeConnected) return;

    await this.waitUntilReady();

    const req = new Request(`http://localhost:${BRIDGE_PORT}`, {
      headers: { Upgrade: 'Websocket', Connection: 'upgrade' }
    });
    const res = await super.fetch(switchPort(req, BRIDGE_PORT));
    const socket = res.webSocket;

    if (!socket) {
      throw new Error('WebSocket upgrade to plugin port failed');
    }

    socket.accept();

    const sandboxApi = new SandboxRpcApi(this.env);
    newWebSocketRpcSession(socket, sandboxApi);

    this.bridgeConnected = true;
    console.log("[opencode-do] Cap'n Web bridge established");
  }
}

// ── CodeSandbox DO ───────────────────────────────────────────────

export class CodeSandbox extends Sandbox {}

// ── Log streaming ────────────────────────────────────────────────

async function streamLogsToConsole(
  sandbox: ReturnType<typeof getSandbox>,
  processId: string
) {
  try {
    const stream = await sandbox.streamProcessLogs(processId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (buffer.includes('\n')) {
        const newlineIdx = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data: ')) continue;

        const payload = line.slice(6);
        try {
          const event = JSON.parse(payload);
          if (event.data) {
            process.stdout.write(`[opencode] ${event.data}`);
          }
        } catch {
          if (payload.trim()) {
            console.log(`[opencode] ${payload}`);
          }
        }
      }
    }

    if (buffer.trim()) {
      console.log(`[opencode] ${buffer}`);
    }
  } catch (err) {
    console.error('[opencode] log stream error:', err);
  }
}

// ── Worker (stateless — just proxies to the DO) ──────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const opencode = getSandbox(env.OPENCODE, 'opencode');

    // Start the OpenCode server (idempotent — reuses if already running)
    const server = await createOpencodeServer(opencode, {
      directory: '/home/user/project',
      config: getConfig(env),
      onStart: async ({ process: proc }) => {
        console.log(`[opencode] process started (id=${proc.id})`);
        streamLogsToConsole(opencode, proc.id);
      }
    });
    await opencode.waitUntilReady();

    // Proxy everything to OpenCode (handles SPA, API, ?url= redirect)
    return proxyToOpencode(request, opencode, server);
  }
};
