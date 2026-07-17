import { switchPort } from '@cloudflare/containers';
import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox,
  proxyToSandbox
} from '@cloudflare/sandbox';
import { type GitCheckoutOptions, withGit } from '@cloudflare/sandbox/git';
import {
  autoApprove,
  compose,
  enforceModel,
  enforcePolicy,
  type HandlerContext,
  isRequest,
  type JsonRpcMessage,
  log,
  type MessageHandler,
  tryParse
} from './rpc';

export { ContainerProxy };

export type CodexServerAdmission = { processId: string; token: string };

const CODEX_WS_PORT = 4500;
const CODEX_WS_TOKEN_FILE = '/tmp/codex-ws-token';

export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false;
  interceptHttps = true;

  private codexServerAdmission: Promise<CodexServerAdmission> | null = null;

  git = withGit(this);

  gitCheckout(repoUrl: string, options?: GitCheckoutOptions) {
    return this.git.checkout(repoUrl, options);
  }

  async ensureCodexAppServer(): Promise<CodexServerAdmission> {
    this.codexServerAdmission ??= this.admitCodexAppServer();
    try {
      return await this.codexServerAdmission;
    } finally {
      this.codexServerAdmission = null;
    }
  }

  private async admitCodexAppServer(): Promise<CodexServerAdmission> {
    const procs = await this.listProcesses();
    const expectedCmd = [
      '/bin/bash',
      '-lc',
      `codex app-server --listen ws://0.0.0.0:${CODEX_WS_PORT} --ws-auth capability-token --ws-token-file ${CODEX_WS_TOKEN_FILE}`
    ] as const;

    const running = procs.find(
      (p) =>
        p.state === 'running' &&
        p.command.length === expectedCmd.length &&
        p.command.every((val, index) => val === expectedCmd[index])
    );

    if (running) {
      const tokenFile = await this.readFile(CODEX_WS_TOKEN_FILE);
      if (tokenFile.content && tokenFile.content.trim() !== '') {
        return { processId: running.id, token: tokenFile.content.trim() };
      }
    }

    const codexWsToken = generateCapabilityToken();

    await this.setEnvVars({
      OPENAI_BASE_URL: 'http://api.openai.com/v1',
      OPENAI_API_KEY: 'proxy-injected'
    });
    await this.writeFile(CODEX_WS_TOKEN_FILE, codexWsToken);

    const proc = await this.exec(expectedCmd);
    return { processId: proc.id, token: codexWsToken };
  }

  async waitForPortReady(port: number): Promise<void> {
    const watch = await this.client.ports.openWatch(port);
    const stream = await watch.stream();
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error(`Port ${port} watch closed before ready`);
        }
        if (value) {
          if (value.type === 'ready') {
            return;
          }
          if (value.type === 'error') {
            throw new Error(`Port ${port} watch reported error`);
          }
        }
      }
    } finally {
      await reader.cancel();
      watch[Symbol.dispose]?.();
    }
  }
}

declare global {
  interface Env {
    OPENAI_API_KEY: string;
    AUTH_TOKEN?: string;
    SANDBOX_SLEEP_AFTER?: string;
  }
}

type CodexSandboxClient = ReturnType<typeof getSandbox<Sandbox>>;

// --- Egress control ---
// The container uses OPENAI_BASE_URL=http://api.openai.com/v1 so requests
// hit the outbound handler, which injects the real API key and upgrades to
// HTTPS. The key never enters the container. With interceptHttps = true,
// HTTPS requests are also intercepted via the Cloudflare CA cert.

Sandbox.outboundByHost = {
  'api.openai.com': async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
    headers.delete('X-Api-Key');
    return fetch(`https://api.openai.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body
    });
  },
  'github.com': async (request: Request) => {
    const url = new URL(request.url);
    const target = `https://github.com${url.pathname}${url.search}`;
    console.log(`[egress] Allowed: ${request.method} ${target}`);
    return fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
  }
};

Sandbox.outbound = async (request: Request) => {
  console.log(`[egress] Blocked: ${request.method} ${request.url}`);
  return new Response('Forbidden by egress policy', { status: 403 });
};

// --- Custom command: sandbox/setup ---
// Wipes /workspace and clones a fresh copy of the repo.

export function sandboxSetup(sandbox: CodexSandboxClient): MessageHandler {
  return (msg, ctx) => {
    if (
      ctx.direction !== 'client-to-server' ||
      !isRequest(msg) ||
      msg.method !== 'sandbox/setup'
    ) {
      return msg;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const repoUrl = params.repoUrl as string | undefined;
    if (!repoUrl) {
      ctx.sendToClient({
        id: msg.id,
        error: { code: -32602, message: 'Missing param: repoUrl' }
      });
      return null;
    }

    (async () => {
      try {
        const cleanup = await sandbox.exec([
          '/bin/bash',
          '-lc',
          'find /workspace -mindepth 1 -delete 2>/dev/null; true'
        ]);
        await cleanup.waitForExit();
        const result = await sandbox.gitCheckout(repoUrl, {
          branch: params.branch as string | undefined,
          targetDir: '/workspace',
          depth: 1
        });
        ctx.sendToClient({ id: msg.id, result: { ok: true, ...result } });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.sendToClient({ id: msg.id, error: { code: -32000, message } });
      }
    })();

    return null;
  };
}

// --- Custom command: sandbox/exec ---

function sandboxExec(sandbox: CodexSandboxClient): MessageHandler {
  return (msg, ctx) => {
    if (
      ctx.direction !== 'client-to-server' ||
      !isRequest(msg) ||
      msg.method !== 'sandbox/exec'
    ) {
      return msg;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const command = params.command as string | undefined;
    if (!command) {
      ctx.sendToClient({
        id: msg.id,
        error: { code: -32602, message: 'Missing param: command' }
      });
      return null;
    }

    sandbox
      .exec(['/bin/bash', '-lc', command])
      .then(async (process) =>
        ctx.sendToClient({
          id: msg.id,
          result: await process.output({ encoding: 'utf8' })
        })
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.sendToClient({ id: msg.id, error: { code: -32000, message } });
      });

    return null;
  };
}

// --- Sandbox lifecycle ---

function generateCapabilityToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

// --- Auth ---

function checkAuth(request: Request, url: URL, env: Env): Response | null {
  const token = env.AUTH_TOKEN;
  if (!token) return null;

  const header = request.headers.get('Authorization');
  if (header === `Bearer ${token}`) return null;

  if (url.searchParams.get('token') === token) return null;

  return new Response('Unauthorized', { status: 401 });
}

// --- Worker ---

const SANDBOX_ID_RE = /^\/ws\/([a-zA-Z0-9_-]{1,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxied = await proxyToSandbox(
      request,
      env as unknown as Parameters<typeof proxyToSandbox>[1]
    );
    if (proxied) return proxied;

    const url = new URL(request.url);
    const match = url.pathname.match(SANDBOX_ID_RE);
    if (match) return handleWebSocket(request, url, env, match[1]);

    if (url.pathname !== '/') return env.Assets.fetch(request);

    const wsProto = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new HTMLRewriter()
      .on('html', {
        element(el) {
          el.setAttribute('data-ws-endpoint', `${wsProto}//${url.host}/ws`);
        }
      })
      .transform(await env.Assets.fetch(request));
  }
};

// --- WebSocket bridge ---

async function connectToContainer(
  sandbox: CodexSandboxClient,
  codexWsToken: string
): Promise<WebSocket> {
  const wsRequest = switchPort(
    new Request('http://container/ws', {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        Authorization: `Bearer ${codexWsToken}`
      }
    }),
    CODEX_WS_PORT
  );
  const ws = (await sandbox.fetch(wsRequest)).webSocket;
  if (!ws) throw new Error('Failed to connect to Codex container');
  return ws;
}

async function handleWebSocket(
  request: Request,
  url: URL,
  env: Env,
  sandboxId: string
): Promise<Response> {
  const denied = checkAuth(request, url, env);
  if (denied) return denied;

  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const sleepAfter = env.SANDBOX_SLEEP_AFTER || '1m';
  const sandbox = getSandbox<Sandbox>(env.Sandbox, `codex-${sandboxId}`, {
    sleepAfter
  });
  const { processId, token: codexWsToken } =
    await sandbox.ensureCodexAppServer();

  const proc = await sandbox.getProcess(processId);
  if (!proc) {
    throw new Error(`Admitted app server process ${processId} was lost`);
  }

  // Ensure port readiness at the caller boundary so both newly launched and recovered processes are gated
  await sandbox.waitForPortReady(CODEX_WS_PORT);

  const containerWs = await connectToContainer(sandbox, codexWsToken);

  const [clientWs, serverWs] = Object.values(new WebSocketPair());
  const sendJson = (ws: WebSocket) => (msg: JsonRpcMessage) =>
    ws.send(JSON.stringify(msg));
  const toClient = sendJson(serverWs);
  const toServer = sendJson(containerWs);

  const clientToServerCtx: HandlerContext = {
    direction: 'client-to-server',
    sendToClient: toClient,
    sendToServer: toServer
  };
  const serverToClientCtx: HandlerContext = {
    direction: 'server-to-client',
    sendToClient: toClient,
    sendToServer: toServer
  };

  const pipeline = compose(
    log(),
    enforceModel('gpt-5.4'),
    enforcePolicy({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' }
    }),
    sandboxSetup(sandbox),
    sandboxExec(sandbox),
    autoApprove()
  );

  serverWs.accept();
  containerWs.accept();

  const bridge = (from: WebSocket, to: WebSocket, ctx: HandlerContext) => {
    from.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      const msg = tryParse(raw);
      if (!msg) {
        to.send(raw);
        return;
      }
      const result = pipeline(msg, ctx);
      if (!result) return;
      to.send(result === msg ? raw : JSON.stringify(result));
    });
  };

  bridge(serverWs, containerWs, clientToServerCtx);
  bridge(containerWs, serverWs, serverToClientCtx);

  const safeClose = (ws: WebSocket, code: number, reason: string) => {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  serverWs.addEventListener('close', (e: CloseEvent) =>
    safeClose(containerWs, e.code, e.reason)
  );
  containerWs.addEventListener('close', (e: CloseEvent) =>
    safeClose(serverWs, e.code, e.reason)
  );
  serverWs.addEventListener('error', () =>
    safeClose(containerWs, 1011, 'Client error')
  );
  containerWs.addEventListener('error', () =>
    safeClose(serverWs, 1011, 'Container error')
  );

  return new Response(null, { status: 101, webSocket: clientWs });
}
