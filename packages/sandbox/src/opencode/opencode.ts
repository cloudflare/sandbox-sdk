import type { Config } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { createLogger, type Logger, type SandboxProcess } from '@repo/shared';
import type { Sandbox } from '../sandbox';
import type { OpencodeOptions, OpencodeServer } from './types';
import { OpencodeStartupError } from './types';

// Lazy logger creation to avoid global scope restrictions in Workers
function getLogger(): Logger {
  return createLogger({ component: 'sandbox-do', operation: 'opencode' });
}

const DEFAULT_PORT = 4096;
const OPENCODE_STARTUP_TIMEOUT_MS = 180_000;
const OPENCODE_SERVE = (port: number) =>
  `opencode serve --port ${port} --hostname 0.0.0.0`;

/**
 * Build the full command, optionally with a directory prefix.
 * If directory is provided, we cd to it first so OpenCode uses it as cwd.
 */
function buildOpencodeCommand(port: number, directory?: string): string {
  const serve = OPENCODE_SERVE(port);
  return directory ? `cd ${directory} && ${serve}` : serve;
}

/**
 * Find an existing OpenCode server process running on the specified port.
 * Returns the process if found and still active, null otherwise.
 * Matches by the serve command pattern since directory prefix may vary.
 */
async function findExistingOpencodeProcess(
  sandbox: Sandbox<unknown>,
  port: number
): Promise<SandboxProcess | null> {
  const processes = await sandbox.listProcesses();
  const serveCommand = OPENCODE_SERVE(port);

  // Re-attach (via `getProcess`) so the returned handle has live
  // replay-then-tail streams; the snapshot from `listProcesses` has
  // `stdout`/`stderr` set to `null`.
  for (const snapshot of processes) {
    if (!snapshot.command.includes(serveCommand)) continue;
    const status = await snapshot.status();
    if (status !== 'starting' && status !== 'running') continue;
    return (await sandbox.getProcess(snapshot.id)) ?? snapshot;
  }

  return null;
}

/**
 * Ensures OpenCode server is running in the container.
 * Reuses existing process if one is already running on the specified port.
 * Handles concurrent startup attempts gracefully by retrying on failure.
 * Returns the process handle.
 */
async function ensureOpencodeServer(
  sandbox: Sandbox<unknown>,
  port: number,
  directory?: string,
  config?: Config,
  customEnv?: Record<string, string>
): Promise<SandboxProcess> {
  // Check if OpenCode is already running on this port
  const existingProcess = await findExistingOpencodeProcess(sandbox, port);
  if (existingProcess) {
    // Reuse existing process - wait for it to be ready if still starting
    if ((await existingProcess.status()) === 'starting') {
      getLogger().debug('Found starting OpenCode process, waiting for ready', {
        port,
        processId: existingProcess.id
      });
      try {
        await existingProcess.waitForPort(port, {
          mode: 'http',
          path: '/path',
          status: 200,
          timeout: OPENCODE_STARTUP_TIMEOUT_MS
        });
      } catch (e) {
        const logs = await existingProcess.getLogs();
        throw new OpencodeStartupError(
          `OpenCode server failed to start. Stderr: ${logs.stderr || '(empty)'}`,
          { port, stderr: logs.stderr, command: existingProcess.command },
          { cause: e }
        );
      }
    }
    getLogger().debug('Reusing existing OpenCode process', {
      port,
      processId: existingProcess.id
    });
    return existingProcess;
  }

  // Try to start a new OpenCode server
  try {
    return await startOpencodeServer(
      sandbox,
      port,
      directory,
      config,
      customEnv
    );
  } catch (startupError) {
    // Startup failed - check if another concurrent request started the server
    // This handles the race condition where multiple requests try to start simultaneously
    const retryProcess = await findExistingOpencodeProcess(sandbox, port);
    if (retryProcess) {
      getLogger().debug(
        'Startup failed but found concurrent process, reusing',
        {
          port,
          processId: retryProcess.id
        }
      );
      // Wait for the concurrent server to be ready
      if ((await retryProcess.status()) === 'starting') {
        try {
          await retryProcess.waitForPort(port, {
            mode: 'http',
            path: '/path',
            status: 200,
            timeout: OPENCODE_STARTUP_TIMEOUT_MS
          });
        } catch (e) {
          const logs = await retryProcess.getLogs();
          throw new OpencodeStartupError(
            `OpenCode server failed to start. Stderr: ${logs.stderr || '(empty)'}`,
            { port, stderr: logs.stderr, command: retryProcess.command },
            { cause: e }
          );
        }
      }
      return retryProcess;
    }

    // No concurrent server found - the failure was genuine
    throw startupError;
  }
}

/**
 * Internal function to start a new OpenCode server process.
 */
async function startOpencodeServer(
  sandbox: Sandbox<unknown>,
  port: number,
  directory?: string,
  config?: Config,
  customEnv?: Record<string, string>
): Promise<SandboxProcess> {
  getLogger().info('Starting OpenCode server', { port, directory });

  // Pass config via OPENCODE_CONFIG_CONTENT and also extract API keys to env vars
  // because OpenCode's provider auth looks for env vars like ANTHROPIC_API_KEY
  const env: Record<string, string> = {};

  if (config) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    // Extract API keys from provider config
    // Support both options.apiKey (official type) and legacy top-level apiKey
    if (
      config.provider &&
      typeof config.provider === 'object' &&
      !Array.isArray(config.provider)
    ) {
      for (const [providerId, providerConfig] of Object.entries(
        config.provider
      )) {
        if (providerId === 'cloudflare-ai-gateway') {
          continue;
        }

        // Try options.apiKey first (official Config type)
        let apiKey = providerConfig?.options?.apiKey;
        // Fall back to top-level apiKey for convenience
        if (!apiKey) {
          apiKey = (providerConfig as Record<string, unknown> | undefined)
            ?.apiKey as string | undefined;
        }
        if (typeof apiKey === 'string') {
          const envVar = `${providerId.toUpperCase()}_API_KEY`;
          env[envVar] = apiKey;
        }
      }

      const aiGatewayConfig = config.provider['cloudflare-ai-gateway'];
      if (aiGatewayConfig?.options) {
        const options = aiGatewayConfig.options as Record<string, unknown>;

        if (typeof options.accountId === 'string') {
          env.CLOUDFLARE_ACCOUNT_ID = options.accountId;
        }

        if (typeof options.gatewayId === 'string') {
          env.CLOUDFLARE_GATEWAY_ID = options.gatewayId;
        }

        if (typeof options.apiToken === 'string') {
          env.CLOUDFLARE_API_TOKEN = options.apiToken;
        }
      }
    }
  }

  // Custom env vars override config-extracted ones
  if (customEnv) {
    Object.assign(env, customEnv);
  }

  const command = buildOpencodeCommand(port, directory);
  const process = await sandbox.exec(command, {
    env: Object.keys(env).length > 0 ? env : undefined
  });

  // Wait for server to be ready - check the actual health endpoint
  try {
    await process.waitForPort(port, {
      mode: 'http',
      path: '/path',
      status: 200,
      timeout: OPENCODE_STARTUP_TIMEOUT_MS
    });
    getLogger().info('OpenCode server started successfully', {
      port,
      processId: process.id
    });
  } catch (e) {
    const logs = await process.getLogs();
    const error = e instanceof Error ? e : undefined;
    getLogger().error('OpenCode server failed to start', error, {
      port,
      stderr: logs.stderr
    });
    throw new OpencodeStartupError(
      `OpenCode server failed to start. Stderr: ${logs.stderr || '(empty)'}`,
      { port, stderr: logs.stderr, command },
      { cause: e }
    );
  }

  return process;
}

/**
 * Starts an OpenCode server inside a Sandbox container.
 *
 * This function manages the server lifecycle only - use `createOpencode()` if you
 * also need a typed SDK client for programmatic access.
 *
 * If an OpenCode server is already running on the specified port, this function
 * will reuse it instead of starting a new one.
 *
 * @param sandbox - The Sandbox instance to run OpenCode in
 * @param options - Configuration options
 * @returns Promise resolving to server handle { port, url, close() }
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencodeServer } from '@cloudflare/sandbox/opencode'
 *
 * const sandbox = getSandbox(env.Sandbox, 'my-agent')
 * const server = await createOpencodeServer(sandbox, {
 *   directory: '/home/user/my-project',
 *   config: {
 *     provider: {
 *       anthropic: {
 *         options: { apiKey: env.ANTHROPIC_KEY }
 *       },
 *       // Or use Cloudflare AI Gateway (with unified billing, no provider keys needed).
 *       // 'cloudflare-ai-gateway': {
 *       //   options: {
 *       //     accountId: env.CF_ACCOUNT_ID,
 *       //     gatewayId: env.CF_GATEWAY_ID,
 *       //     apiToken: env.CF_API_TOKEN
 *       //   },
 *       //   models: { 'anthropic/claude-sonnet-4-5-20250929': {} }
 *       // }
 *     }
 *   }
 * })
 *
 * // Proxy requests to the web UI
 * return sandbox.containerFetch(request, server.port)
 *
 * // When done
 * await server.close()
 * ```
 */
export async function createOpencodeServer(
  sandbox: Sandbox<unknown>,
  options?: OpencodeOptions
): Promise<OpencodeServer> {
  const port = options?.port ?? DEFAULT_PORT;
  const process = await ensureOpencodeServer(
    sandbox,
    port,
    options?.directory,
    options?.config,
    options?.env
  );

  return {
    port,
    url: `http://localhost:${port}`,
    close: async () => {
      process.kill('SIGTERM');
      await process.exitCode.catch(() => {
        /* exit observed */
      });
    }
  };
}

/**
 * Proxy a request directly to the OpenCode server.
 *
 * Unlike `proxyToOpencode()`, this helper does not apply any web UI redirects
 * or query parameter rewrites. Use it for API/CLI traffic where raw request
 * forwarding is preferred.
 */
export function proxyToOpencodeServer(
  request: Request,
  sandbox: Sandbox<unknown>,
  server: OpencodeServer
): Promise<Response> {
  return sandbox.containerFetch(request, server.port);
}

/**
 * Proxy a request to the OpenCode web UI.
 *
 * This function handles the redirect and proxying only - you must start the
 * server separately using `createOpencodeServer()`.
 *
 * Specifically handles:
 * 1. Ensuring the `?url=` parameter is set (required for OpenCode's frontend to
 *    make API calls through the proxy instead of directly to localhost:4096)
 * 2. Proxying the request to the container
 *
 * @param request - The incoming HTTP request
 * @param sandbox - The Sandbox instance running OpenCode
 * @param server - The OpenCode server handle from createOpencodeServer()
 * @returns Response from OpenCode or a redirect response
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencodeServer, proxyToOpencode } from '@cloudflare/sandbox/opencode'
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const sandbox = getSandbox(env.Sandbox, 'opencode')
 *     const server = await createOpencodeServer(sandbox, {
 *       directory: '/home/user/project',
 *       config: {
 *         provider: {
 *           anthropic: {
 *             options: { apiKey: env.ANTHROPIC_KEY }
 *           },
 *           // Optional: Route all providers through Cloudflare AI Gateway
 *           'cloudflare-ai-gateway': {
 *             options: {
 *               accountId: env.CF_ACCOUNT_ID,
 *               gatewayId: env.CF_GATEWAY_ID,
 *               apiToken: env.CF_API_TOKEN
 *             }
 *           }
 *         }
 *       }
 *     })
 *     return proxyToOpencode(request, sandbox, server)
 *   }
 * }
 * ```
 */
export function proxyToOpencode(
  request: Request,
  sandbox: Sandbox<unknown>,
  server: OpencodeServer
): Response | Promise<Response> {
  const url = new URL(request.url);

  // OpenCode's frontend defaults to http://127.0.0.1:4096 when hostname includes
  // "localhost" or "opencode.ai". The ?url= parameter overrides this behavior.
  // We only redirect GET requests for HTML pages (initial page load).
  // API calls (POST, PATCH, etc.) and asset requests are proxied directly
  // since redirecting POST loses the request body.
  if (!url.searchParams.has('url') && request.method === 'GET') {
    const accept = request.headers.get('accept') || '';
    const isHtmlRequest = accept.includes('text/html') || url.pathname === '/';
    if (isHtmlRequest) {
      url.searchParams.set('url', url.origin);
      return Response.redirect(url.toString(), 302);
    }
  }

  return proxyToOpencodeServer(request, sandbox, server);
}
