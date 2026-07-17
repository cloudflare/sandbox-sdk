import {
  createExtensionProcessSandbox,
  type SandboxLike
} from '@cloudflare/sandbox/extensions';
import type { Config } from '@opencode-ai/sdk/v2';
import {
  createLogger,
  type Logger,
  type SandboxCommand,
  type SandboxProcess
} from '@repo/shared';
import type { OpenCodeOptions, OpenCodeServer } from './types';
import { OpenCodeStartupError } from './types';

// Lazy logger creation to avoid global scope restrictions in Workers
function getLogger(): Logger {
  return createLogger({ component: 'sandbox-do', operation: 'opencode' });
}

export interface OpenCodeSandboxLike extends SandboxLike {
  exec: NonNullable<SandboxLike['exec']>;
  getProcess: NonNullable<SandboxLike['getProcess']>;
  listProcesses: NonNullable<SandboxLike['listProcesses']>;
  containerFetch(request: Request, port: number): Promise<Response>;
}

const DEFAULT_PORT = 4096;
const OPENCODE_STARTUP_TIMEOUT_MS = 180_000;
function openCodeCommand(port: number): SandboxCommand {
  return ['opencode', 'serve', '--port', String(port), '--hostname', '0.0.0.0'];
}

function commandsEqual(a: SandboxCommand, b: SandboxCommand): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Recover a running OpenCode process from runtime-local process status. */
export async function findExistingOpenCodeProcess(
  sandbox: OpenCodeSandboxLike,
  port: number,
  directory?: string
): Promise<SandboxProcess | null> {
  const command = openCodeCommand(port);
  const processes = createExtensionProcessSandbox(sandbox);
  const status = (await processes.listProcesses()).find(
    (candidate) =>
      candidate.state === 'running' &&
      candidate.cwd === directory &&
      commandsEqual(candidate.command, command)
  );
  return status ? processes.getProcess(status.id) : null;
}

async function collectStderr(process: SandboxProcess): Promise<string> {
  const stream = await process.logs({ replay: true, follow: false });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stderr = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'stderr') {
        stderr += decoder.decode(value.data, { stream: true });
      }
    }
    return stderr + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Ensures OpenCode server is running in the container.
 * Reuses existing process if one is already running on the specified port.
 * Handles concurrent startup attempts gracefully by retrying on failure.
 * Returns the process handle.
 */
async function ensureOpenCodeServer(
  sandbox: OpenCodeSandboxLike,
  port: number,
  directory?: string,
  config?: Config,
  customEnv?: Record<string, string>
): Promise<SandboxProcess> {
  const existingProcess = await findExistingOpenCodeProcess(
    sandbox,
    port,
    directory
  );
  if (existingProcess) {
    getLogger().debug('Reusing existing OpenCode process', {
      port,
      processId: existingProcess.id
    });
    return existingProcess;
  }

  // Try to start a new OpenCode server
  try {
    return await startOpenCodeServer(
      sandbox,
      port,
      directory,
      config,
      customEnv
    );
  } catch (startupError) {
    // Startup failed - check if another concurrent request started the server
    // This handles the race condition where multiple requests try to start simultaneously
    const retryProcess = await findExistingOpenCodeProcess(
      sandbox,
      port,
      directory
    );
    if (retryProcess) {
      getLogger().debug(
        'Startup failed but found concurrent process, reusing',
        { port, processId: retryProcess.id }
      );
      return retryProcess;
    }

    // No concurrent server found - the failure was genuine
    throw startupError;
  }
}

/**
 * Internal function to start a new OpenCode server process.
 */
async function startOpenCodeServer(
  sandbox: OpenCodeSandboxLike,
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

  const command = openCodeCommand(port);
  const process = await createExtensionProcessSandbox(sandbox).exec(command, {
    cwd: directory,
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
    const stderr = await collectStderr(process);
    const error = e instanceof Error ? e : undefined;
    getLogger().error('OpenCode server failed to start', error, {
      port,
      stderr
    });
    throw new OpenCodeStartupError(
      `OpenCode server failed to start. Stderr: ${stderr || '(empty)'}`,
      { port, stderr, command: command.join(' ') },
      { cause: e }
    );
  }

  return process;
}

/**
 * Starts an OpenCode server inside a Sandbox container.
 *
 * This function manages the server lifecycle only - use `createOpenCodeClient()` if you
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
 * import { createOpenCodeServer } from '@cloudflare/sandbox/opencode'
 *
 * const sandbox = getSandbox(env.Sandbox, 'my-agent')
 * const server = await createOpenCodeServer(sandbox, {
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
export async function createOpenCodeServer(
  sandbox: OpenCodeSandboxLike,
  options?: OpenCodeOptions
): Promise<OpenCodeServer> {
  const port = options?.port ?? DEFAULT_PORT;
  const process = await ensureOpenCodeServer(
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
      await process.kill(15);
      await process.waitForExit().catch(() => {
        /* exit observed */
      });
    }
  };
}

/**
 * Proxy a request directly to the OpenCode server.
 *
 * Unlike `proxyToOpenCode()`, this helper does not apply any web UI redirects
 * or query parameter rewrites. Use it for API/CLI traffic where raw request
 * forwarding is preferred.
 */
export function proxyToOpenCodeServer(
  request: Request,
  sandbox: OpenCodeSandboxLike,
  server: OpenCodeServer
): Promise<Response> {
  return sandbox.containerFetch(request, server.port);
}

/**
 * Proxy a request to the OpenCode web UI.
 *
 * This function handles the redirect and proxying only - you must start the
 * server separately using `createOpenCodeServer()`.
 *
 * Specifically handles:
 * 1. Ensuring the `?url=` parameter is set (required for OpenCode's frontend to
 *    make API calls through the proxy instead of directly to localhost:4096)
 * 2. Proxying the request to the container
 *
 * @param request - The incoming HTTP request
 * @param sandbox - The Sandbox instance running OpenCode
 * @param server - The OpenCode server handle from createOpenCodeServer()
 * @returns Response from OpenCode or a redirect response
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpenCodeServer, proxyToOpenCode } from '@cloudflare/sandbox/opencode'
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const sandbox = getSandbox(env.Sandbox, 'opencode')
 *     const server = await createOpenCodeServer(sandbox, {
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
 *     return proxyToOpenCode(request, sandbox, server)
 *   }
 * }
 * ```
 */
export function proxyToOpenCode(
  request: Request,
  sandbox: OpenCodeSandboxLike,
  server: OpenCodeServer
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

  return proxyToOpenCodeServer(request, sandbox, server);
}
