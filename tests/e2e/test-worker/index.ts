/**
 * Minimal test worker for integration tests
 *
 * Exposes SDK methods via HTTP endpoints for E2E testing.
 *
 * Sandbox types available:
 * - Sandbox: Base image without Python (default, lean image)
 * - SandboxPython: Full image with Python (for code interpreter tests)
 * - SandboxOpencode: Image with OpenCode CLI (for OpenCode integration tests)
 * - SandboxStandalone: Standalone binary on arbitrary base image (for binary pattern tests)
 * - SandboxMusl: Musl-based Alpine image variant (for musl binary tests)
 *
 * Use X-Sandbox-Type header to select: 'python', 'opencode', 'standalone', 'musl', or default
 */

import type { ProcessLogEvent, TerminalOutputEvent } from '@cloudflare/sandbox';
import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox,
  isPlatformTransientError,
  proxyToSandbox
} from '@cloudflare/sandbox';
import { type GitCheckoutOptions, withGit } from '@cloudflare/sandbox/git';
import { withInterpreter } from '@cloudflare/sandbox/interpreter';

import { withOpenCode } from '@cloudflare/sandbox/opencode';
import type {
  BucketDeleteResponse,
  BucketGetResponse,
  BucketPutResponse,
  BucketUnmountResponse,
  CodeContextDeleteResponse,
  ErrorResponse,
  HealthResponse,
  PortUnexposeResponse,
  SuccessResponse,
  SuccessWithMessageResponse,
  WebSocketInitResponse
} from './types';

// Sandbox subclass wiring the code interpreter extension.
export class Sandbox extends BaseSandbox<Env> {
  git = withGit(this);

  gitCheckout(repoUrl: string, options?: GitCheckoutOptions) {
    return this.git.checkout(repoUrl, options);
  }
  interpreter = withInterpreter(this);
  opencode = withOpenCode(this, { port: 4096, storage: this.ctx.storage });
}

// Export Sandbox class with different names for each container type
// The actual image is determined by the container binding in wrangler.jsonc
export { ContainerProxy };
export { Sandbox as SandboxPython };
export { Sandbox as SandboxOpencode };
export { Sandbox as SandboxStandalone };
export { Sandbox as SandboxMusl };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  SandboxPython: DurableObjectNamespace<Sandbox>;
  SandboxOpencode: DurableObjectNamespace<Sandbox>;
  SandboxStandalone: DurableObjectNamespace<Sandbox>;
  SandboxMusl: DurableObjectNamespace<Sandbox>;
  TEST_BUCKET: R2Bucket;
  BACKUP_BUCKET: R2Bucket;
  // R2 credentials for bucket mounting tests
  CLOUDFLARE_ACCOUNT_ID?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  // R2 credentials for backup presigned URL transfers
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  BACKUP_BUCKET_NAME?: string;
  SANDBOX_ENABLE_TEST_HOOKS?: string;
  DEPLOY_HASH?: string;
}

/**
 * Interface for SandboxError shape (direct calls preserve errorResponse property).
 * Used for type-safe error handling without importing the actual class.
 */
interface SandboxErrorLike extends Error {
  errorResponse: {
    message: string;
    code?: string;
    context?: Record<string, unknown>;
    httpStatus?: number;
    suggestion?: string;
  };
  code?: string;
  context?: Record<string, unknown>;
  httpStatus?: number;
  suggestion?: string;
}

/**
 * Type guard for SandboxError-like objects.
 * Checks for the errorResponse property that direct calls preserve.
 */
function isSandboxErrorLike(error: unknown): error is SandboxErrorLike {
  return (
    error instanceof Error &&
    'errorResponse' in error &&
    typeof error.errorResponse === 'object' &&
    error.errorResponse !== null
  );
}

/**
 * Maps SandboxError subclass names to HTTP status codes and error codes.
 * Used as a fallback when errors cross the Cloudflare RPC boundary,
 * which strips own properties and prototype getters, preserving only
 * error.name and error.message.
 */
const ERROR_NAME_MAP: Record<string, { status: number; code: string }> = {
  // Backup errors
  BackupNotFoundError: { status: 404, code: 'BACKUP_NOT_FOUND' },
  BackupExpiredError: { status: 400, code: 'BACKUP_EXPIRED' },
  InvalidBackupConfigError: { status: 400, code: 'INVALID_BACKUP_CONFIG' },
  BackupCreateError: { status: 500, code: 'BACKUP_CREATE_FAILED' },
  BackupRestoreError: { status: 500, code: 'BACKUP_RESTORE_FAILED' },
  OperationInterruptedError: { status: 409, code: 'OPERATION_INTERRUPTED' },
  // File errors
  FileNotFoundError: { status: 404, code: 'FILE_NOT_FOUND' },
  FileExistsError: { status: 409, code: 'FILE_EXISTS' },
  FileSystemError: { status: 500, code: 'FILESYSTEM_ERROR' },
  PermissionDeniedError: { status: 403, code: 'PERMISSION_DENIED' },
  // Command errors
  CommandNotFoundError: { status: 404, code: 'COMMAND_NOT_FOUND' },
  CommandError: { status: 500, code: 'COMMAND_EXECUTION_ERROR' },
  // Process errors
  ProcessNotFoundError: { status: 404, code: 'PROCESS_NOT_FOUND' },
  ProcessError: { status: 500, code: 'PROCESS_ERROR' },
  ProcessReadyTimeoutError: { status: 408, code: 'PROCESS_READY_TIMEOUT' },
  ProcessExitedBeforeReadyError: {
    status: 500,
    code: 'PROCESS_EXITED_BEFORE_READY'
  },
  // Port errors
  PortAlreadyExposedError: { status: 409, code: 'PORT_ALREADY_EXPOSED' },
  PortNotExposedError: { status: 404, code: 'PORT_NOT_EXPOSED' },
  InvalidPortError: { status: 400, code: 'INVALID_PORT' },
  PortInUseError: { status: 409, code: 'PORT_IN_USE' },
  ServiceNotRespondingError: { status: 502, code: 'SERVICE_NOT_RESPONDING' },
  CustomDomainRequiredError: { status: 400, code: 'CUSTOM_DOMAIN_REQUIRED' },
  // Git errors
  GitRepositoryNotFoundError: {
    status: 404,
    code: 'GIT_REPOSITORY_NOT_FOUND'
  },
  GitAuthenticationError: { status: 401, code: 'GIT_AUTH_FAILED' },
  GitBranchNotFoundError: { status: 404, code: 'GIT_BRANCH_NOT_FOUND' },
  GitNetworkError: { status: 502, code: 'GIT_NETWORK_ERROR' },
  InvalidGitUrlError: { status: 400, code: 'INVALID_GIT_URL' },
  GitCloneError: { status: 500, code: 'GIT_CLONE_FAILED' },
  GitCheckoutError: { status: 500, code: 'GIT_CHECKOUT_FAILED' },
  // Code interpreter errors
  InterpreterNotReadyError: { status: 503, code: 'INTERPRETER_NOT_READY' },
  ContainerUnavailableError: { status: 503, code: 'CONTAINER_UNAVAILABLE' },
  ContextNotFoundError: { status: 404, code: 'CONTEXT_NOT_FOUND' },
  CodeExecutionError: { status: 500, code: 'CODE_EXECUTION_ERROR' },
  // Port errors (generic)
  PortError: { status: 500, code: 'PORT_OPERATION_ERROR' },
  // Git errors (generic)
  GitError: { status: 500, code: 'GIT_OPERATION_FAILED' },
  // Security errors
  SandboxSecurityError: { status: 400, code: 'SECURITY_ERROR' },
  // Validation errors
  ValidationFailedError: { status: 400, code: 'VALIDATION_FAILED' },
  // Bucket errors
  BucketMountError: { status: 500, code: 'BUCKET_MOUNT_ERROR' },
  BucketUnmountError: { status: 500, code: 'BUCKET_UNMOUNT_ERROR' },
  S3FSMountError: { status: 500, code: 'S3FS_MOUNT_ERROR' },
  InvalidMountConfigError: { status: 400, code: 'INVALID_MOUNT_CONFIG' },
  MissingCredentialsError: { status: 400, code: 'MISSING_CREDENTIALS' }
};

type CommandArgv = [string, ...string[]];

function isCommandArgv(value: unknown): value is CommandArgv {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((arg) => typeof arg === 'string')
  );
}

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

type RequestBodyValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, string>
  | Record<string, unknown>
  | undefined;

type RequestBody = Record<string, RequestBodyValue>;

function asRecord(value: unknown): RequestBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return {};
  const record: RequestBody = {};
  for (const [key, val] of Object.entries(value))
    record[key] = val as RequestBodyValue;
  return record;
}

function optionalStringRecord(
  value: unknown
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, val]) => typeof val === 'string')) return undefined;
  const record: Record<string, string> = {};
  for (const [key, val] of entries) record[key] = val;
  return record;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

async function readStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const events: T[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return events;
      events.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function serializeBytes(data: Uint8Array): number[] {
  return Array.from(data);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutID = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutID) clearTimeout(timeoutID);
  }
}

async function waitForSandboxStopped(
  sandbox: Pick<BaseSandbox<Env>, 'getState'>,
  timeoutMs = 30_000
): Promise<Awaited<ReturnType<BaseSandbox<Env>['getState']>>> {
  const deadline = Date.now() + timeoutMs;
  let state = await sandbox.getState();
  while (
    state.status !== 'stopped' &&
    state.status !== 'stopped_with_code' &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await sandbox.getState();
  }
  if (state.status !== 'stopped' && state.status !== 'stopped_with_code') {
    throw new Error(
      `Timed out waiting ${timeoutMs}ms for sandbox to stop; last status: ${state.status}`
    );
  }
  return state;
}

function decodeOutput(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function serializeProcessLogEvent(event: ProcessLogEvent) {
  if (event.type === 'stdout' || event.type === 'stderr') {
    return { ...event, data: serializeBytes(event.data) };
  }
  return event;
}

function serializeTerminalOutputEvent(event: TerminalOutputEvent) {
  if (event.type === 'data') {
    return { ...event, data: serializeBytes(event.data) };
  }
  return event;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Route requests to exposed container ports via their preview URLs, but do
    // not let preview proxy detection consume test-worker control routes.
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/cleanup') {
      // Cast: the Sandbox subclass widens the namespace type beyond the base
      // `proxyToSandbox` signature (DurableObjectNamespace is invariant).
      const proxyResponse = await proxyToSandbox(
        request,
        env as unknown as Parameters<typeof proxyToSandbox>[1]
      );
      if (proxyResponse) return proxyResponse;
    }

    // Skip JSON body parsing for streaming endpoints to preserve request.body
    const isStreamingUpload =
      url.pathname === '/api/file/write-stream' && request.method === 'PUT';
    const body = asRecord(isStreamingUpload ? {} : await parseBody(request));

    // Get sandbox ID from header or query param (WebSocket can't send headers)
    // Sandbox ID determines which container instance (Durable Object)
    const baseSandboxId =
      request.headers.get('X-Sandbox-Id') ||
      url.searchParams.get('sandboxId') ||
      'default-test-sandbox';

    const sandboxId = baseSandboxId;

    // Check if keepAlive is requested
    const keepAliveHeader = request.headers.get('X-Sandbox-KeepAlive');
    const keepAlive = keepAliveHeader === 'true';
    const sleepAfter = request.headers.get('X-Sandbox-Sleep-After');
    // Select sandbox type based on X-Sandbox-Type header
    const sandboxType = request.headers.get('X-Sandbox-Type');
    let sandboxNamespace: DurableObjectNamespace<Sandbox>;
    if (sandboxType === 'python') {
      sandboxNamespace = env.SandboxPython;
    } else if (sandboxType === 'opencode') {
      sandboxNamespace = env.SandboxOpencode;
    } else if (sandboxType === 'standalone') {
      sandboxNamespace = env.SandboxStandalone;
    } else if (sandboxType === 'musl') {
      sandboxNamespace = env.SandboxMusl;
    } else {
      sandboxNamespace = env.Sandbox;
    }

    const sandbox = getSandbox(sandboxNamespace, sandboxId, {
      keepAlive,
      ...(sleepAfter !== null && { sleepAfter })
    });

    try {
      // WebSocket init endpoint - starts all WebSocket servers
      if (url.pathname === '/api/init' && request.method === 'POST') {
        const echoScript = `
const port = 8080;
Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    message(ws, message) { ws.send(message); },
    open(ws) { console.log('Echo client connected'); },
    close(ws) { console.log('Echo client disconnected'); },
  },
});
console.log('Echo server on port ' + port);
`;
        await sandbox.writeFile('/tmp/ws-echo.ts', echoScript);
        const proc = await sandbox.exec([
          '/bin/bash',
          '-lc',
          'bun run /tmp/ws-echo.ts'
        ]);
        let error: string | undefined;
        try {
          await proc.waitForPort(8080, {
            mode: 'tcp',
            timeout: 30000,
            interval: 250
          });
        } catch (e: unknown) {
          error = e instanceof Error ? e.message : String(e);
        }

        const response: WebSocketInitResponse = {
          success: !error,
          serversStarted: error ? 0 : 1,
          serversFailed: error ? 1 : 0,
          errors: error ? [error] : undefined
        };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' },
          status: error ? 500 : 200
        });
      }

      // WebSocket endpoints
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        if (url.pathname === '/ws/echo') {
          return await sandbox.wsConnect(request, 8080);
        }
        if (url.pathname === '/ws/code') {
          return await sandbox.wsConnect(request, 8081);
        }
        if (url.pathname === '/ws/terminal') {
          return await sandbox.wsConnect(request, 8082);
        }
      }

      // Health check
      if (url.pathname === '/health') {
        const response: HealthResponse = {
          status: 'ok',
          deploy_hash: env.DEPLOY_HASH
        };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // OpenCode direct server proxy helper
      if (
        url.pathname === '/api/opencode/proxy-server/global-health' &&
        request.method === 'GET'
      ) {
        const opencodeRequest = new Request(
          `${url.origin}/global/health${url.search}`,
          request
        );

        const response = await sandbox.opencode.fetch(opencodeRequest);

        return new Response(response.body, {
          status: response.status,
          headers: response.headers
        });
      }

      if (url.pathname === '/api/state' && request.method === 'GET') {
        const result = await sandbox.getState();
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Command execution
      if (url.pathname === '/api/execute' && request.method === 'POST') {
        const { command, timeout, env, cwd } = body;
        if (!isCommandArgv(command)) {
          return new Response(
            JSON.stringify({ error: 'command must be a non-empty argv array' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (timeout !== undefined && typeof timeout !== 'number') {
          return new Response(
            JSON.stringify({ error: 'timeout must be a number' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const proc = await sandbox.exec(command, {
          timeout,
          env,
          cwd
        });
        const output = await proc.output();
        const exitCode = output.exitCode;
        const jsonResponse = {
          success: exitCode === 0,
          exitCode,
          signal: output.signal,
          timedOut: output.timedOut,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
          command,
          duration: 0,
          timestamp: new Date().toISOString()
        };
        return new Response(JSON.stringify(jsonResponse), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname === '/api/process/log-follow-cancel-regression' &&
        request.method === 'POST'
      ) {
        const proc = await sandbox.exec(
          ['/bin/bash', '-lc', 'sleep 1; printf follow-ready; sleep 30'],
          { timeout: 10000 }
        );
        let output = '';
        let stateAfterCancel = '';
        let exitCode = 0;
        try {
          const stream = await proc.logs({ replay: false, follow: true });
          const reader = stream.getReader();
          try {
            for (;;) {
              const result = await reader.read();
              if (result.done) break;
              if (result.value.type === 'stdout') {
                output += new TextDecoder().decode(result.value.data);
                if (output.includes('follow-ready')) break;
              }
            }
          } finally {
            try {
              await reader.cancel();
            } finally {
              reader.releaseLock();
            }
          }
          stateAfterCancel = (await proc.status()).state;
        } finally {
          await proc.kill();
          exitCode = (await proc.waitForExit()).code;
        }
        return new Response(
          JSON.stringify({
            output,
            stateAfterCancel,
            exitCode
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Issue #764: AbortSignal must stay caller-local rather than crossing Worker→DO RPC.
      if (
        url.pathname === '/api/process/abort-wait-regression' &&
        request.method === 'POST'
      ) {
        const proc = await sandbox.exec(['/bin/bash', '-lc', 'sleep 30']);
        const controller = new AbortController();
        const wait = proc.waitForExit({ signal: controller.signal });
        controller.abort();
        let waitError = '';
        try {
          await wait;
        } catch (error) {
          waitError = error instanceof Error ? error.name : String(error);
        }
        const statusAfterAbort = await proc.status();
        await proc.kill();
        const exit = await proc.waitForExit();
        return new Response(
          JSON.stringify({
            waitRejected: waitError.length > 0,
            dataCloneError: waitError === 'DataCloneError',
            stateAfterAbort: statusAfterAbort.state,
            exitCode: exit.code
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (
        url.pathname === '/api/process/runtime-fencing-regression' &&
        request.method === 'POST'
      ) {
        const oldProcess = await sandbox.exec([
          '/bin/bash',
          '-lc',
          'echo admitted; sleep 30'
        ]);
        await oldProcess.waitForLog('admitted');
        const racingWait = oldProcess.waitForExit().then(
          () => '',
          (error: unknown) =>
            error instanceof Error ? error.name : String(error)
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await sandbox.destroy();

        const stoppedList = await sandbox.listProcesses();
        const stoppedGet = await sandbox.getProcess(oldProcess.id);
        const replacement = await sandbox.exec(['printf', 'replacement']);
        await replacement.waitForExit();

        let staleError = '';
        try {
          await oldProcess.status();
        } catch (error) {
          staleError = error instanceof Error ? error.name : String(error);
        }
        const racingError = await racingWait;

        const live = await sandbox.exec(['/bin/bash', '-lc', 'sleep 30']);
        const recovered = await sandbox.getProcess(live.id);
        const recoveredStatus = await recovered?.status();
        await recovered?.kill();
        await recovered?.waitForExit();

        return new Response(
          JSON.stringify({
            stoppedListCount: stoppedList.length,
            stoppedGetFound: stoppedGet !== null,
            staleError,
            racingError,
            recoveredState: recoveredStatus?.state
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Process lifecycle routes for coding-agent-shaped E2E workflows.
      if (url.pathname === '/api/process/start' && request.method === 'POST') {
        const command = body.command;
        if (!isCommandArgv(command)) {
          return new Response(
            JSON.stringify({ error: 'command must be a non-empty argv array' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const proc = await sandbox.exec(command, {
          timeout: optionalNumber(body.timeout),
          env: optionalStringRecord(body.env),
          cwd: optionalString(body.cwd)
        });
        const status = await proc.status();
        return new Response(JSON.stringify(status), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url.pathname === '/api/process/list' && request.method === 'GET') {
        const statuses = await sandbox.listProcesses();
        return new Response(JSON.stringify(statuses), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname.startsWith('/api/process/') &&
        request.method === 'GET'
      ) {
        const pathParts = url.pathname.split('/').filter(Boolean);
        const processId = pathParts[2];
        const action = pathParts[3] ?? 'status';
        const proc = await sandbox.getProcess(processId);
        if (!proc) {
          return new Response(JSON.stringify({ error: 'Process not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'logs') {
          const stream = await proc.logs({
            since: optionalString(url.searchParams.get('since') ?? undefined),
            replay: url.searchParams.get('replay') !== 'false',
            follow: url.searchParams.get('follow') === 'true'
          });
          const events = (await readStream(stream)).map(
            serializeProcessLogEvent
          );
          return new Response(JSON.stringify({ events }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const status = await proc.status();
        return new Response(JSON.stringify(status), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname.startsWith('/api/process/') &&
        request.method === 'POST'
      ) {
        const pathParts = url.pathname.split('/').filter(Boolean);
        const processId = pathParts[2];
        const action = pathParts[3];
        const proc = await sandbox.getProcess(processId);
        if (!proc) {
          return new Response(JSON.stringify({ error: 'Process not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'wait') {
          const exit = await proc.waitForExit({
            timeout: optionalNumber(body.timeout)
          });
          return new Response(JSON.stringify(exit), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'wait-for-log') {
          const pattern = optionalString(body.pattern);
          if (!pattern) {
            return new Response(
              JSON.stringify({ error: 'pattern is required' }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          }
          const result = await proc.waitForLog(pattern, {
            timeout: optionalNumber(body.timeout)
          });
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'wait-for-port') {
          const port = optionalNumber(body.port);
          if (port === undefined) {
            return new Response(JSON.stringify({ error: 'port is required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          await proc.waitForPort(port, {
            timeout: optionalNumber(body.timeout),
            mode: body.mode === 'tcp' ? 'tcp' : 'http'
          });
          return new Response(JSON.stringify({ ready: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'kill') {
          await proc.kill(optionalNumber(body.signal) ?? 15);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      if (
        url.pathname === '/api/terminal/create' &&
        request.method === 'POST'
      ) {
        const command = body.command;
        if (!isCommandArgv(command)) {
          return new Response(
            JSON.stringify({ error: 'command must be a non-empty argv array' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const terminal = await sandbox.createTerminal({
          command,
          cwd: optionalString(body.cwd),
          env: optionalStringRecord(body.env),
          cols: optionalNumber(body.cols),
          rows: optionalNumber(body.rows),
          bufferSize: optionalNumber(body.bufferSize)
        });
        return new Response(JSON.stringify(terminal), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname.startsWith('/api/terminal/') &&
        request.method === 'GET'
      ) {
        const pathParts = url.pathname.split('/').filter(Boolean);
        const terminalId = pathParts[2];
        const action = pathParts[3] ?? 'snapshot';
        const terminal = await sandbox.getTerminal(terminalId);
        if (!terminal) {
          return new Response(JSON.stringify({ error: 'Terminal not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'output') {
          const stream = await terminal.output({
            since: optionalString(url.searchParams.get('since') ?? undefined),
            replay: url.searchParams.get('replay') !== 'false',
            follow: url.searchParams.get('follow') === 'true'
          });
          const events = (await readStream(stream)).map(
            serializeTerminalOutputEvent
          );
          return new Response(JSON.stringify({ events }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const snapshot = await terminal.getSnapshot();
        return new Response(JSON.stringify(snapshot), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname.startsWith('/api/terminal/') &&
        request.method === 'POST'
      ) {
        const pathParts = url.pathname.split('/').filter(Boolean);
        const terminalId = pathParts[2];
        const action = pathParts[3];
        const terminal = await sandbox.getTerminal(terminalId);
        if (!terminal) {
          return new Response(JSON.stringify({ error: 'Terminal not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'write') {
          const data = optionalString(body.data);
          if (data === undefined) {
            return new Response(JSON.stringify({ error: 'data is required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          await terminal.write(new TextEncoder().encode(data));
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'resize') {
          const cols = optionalNumber(body.cols);
          const rows = optionalNumber(body.rows);
          if (cols === undefined || rows === undefined) {
            return new Response(
              JSON.stringify({ error: 'cols and rows are required' }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          }
          await terminal.resize(cols, rows);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'interrupt') {
          await terminal.interrupt();
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (action === 'terminate') {
          await terminal.terminate();
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Git clone
      if (url.pathname === '/api/git/clone' && request.method === 'POST') {
        const result = await sandbox.gitCheckout(body.repoUrl, {
          branch: body.branch,
          targetDir: body.targetDir,
          depth: body.depth,
          cloneTimeoutMs: body.cloneTimeoutMs
        });
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Bucket mount
      if (url.pathname === '/api/bucket/mount' && request.method === 'POST') {
        await sandbox.mountBucket(body.bucket, body.mountPath, body.options);
        const response: SuccessResponse = { success: true };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Bucket unmount
      if (url.pathname === '/api/bucket/unmount' && request.method === 'POST') {
        await sandbox.unmountBucket(body.mountPath);
        const response: BucketUnmountResponse = { success: true };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // R2 bucket put
      if (url.pathname === '/api/bucket/put' && request.method === 'POST') {
        await env.TEST_BUCKET.put(body.key, body.content, {
          httpMetadata: body.contentType
            ? { contentType: body.contentType }
            : undefined
        });
        const response: BucketPutResponse = { success: true, key: body.key };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // R2 bucket get
      if (url.pathname === '/api/bucket/get' && request.method === 'GET') {
        const key = url.searchParams.get('key');
        if (!key) {
          const errorResponse: ErrorResponse = {
            error: 'Key parameter required'
          };
          return new Response(JSON.stringify(errorResponse), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const object = await env.TEST_BUCKET.get(key);
        if (!object) {
          const errorResponse: ErrorResponse = { error: 'Object not found' };
          return new Response(JSON.stringify(errorResponse), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const response: BucketGetResponse = {
          success: true,
          key,
          content: await object.text(),
          contentType: object.httpMetadata?.contentType,
          size: object.size
        };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // R2 bucket delete
      if (url.pathname === '/api/bucket/delete' && request.method === 'POST') {
        await env.TEST_BUCKET.delete(body.key);
        const response: BucketDeleteResponse = { success: true, key: body.key };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File read
      if (url.pathname === '/api/file/read' && request.method === 'POST') {
        const file = await sandbox.readFile(body.path);
        return new Response(JSON.stringify(file), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File read stream
      if (url.pathname === '/api/read/stream' && request.method === 'POST') {
        const stream = await sandbox.readFileStream(body.path);
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        });
      }

      // File write
      if (url.pathname === '/api/file/write' && request.method === 'POST') {
        await sandbox.writeFile(body.path, body.content);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File write via streaming (request body piped directly as a ReadableStream)
      if (
        url.pathname === '/api/file/write-stream' &&
        request.method === 'PUT'
      ) {
        const filePath = request.headers.get('X-File-Path');
        if (!filePath || !request.body) {
          return new Response(
            JSON.stringify({ error: 'X-File-Path header and body required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const result = await sandbox.writeFile(filePath, request.body);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File read-binary: readFile({ encoding: 'none' }).
      // Returns raw binary response so the test can sha256 the collected bytes.
      if (
        url.pathname === '/api/file/read-binary' &&
        request.method === 'POST'
      ) {
        const result = await sandbox.readFile(body.path, { encoding: 'none' });
        return new Response(result.content, {
          headers: { 'Content-Type': result.mimeType }
        });
      }

      // File mkdir
      if (url.pathname === '/api/file/mkdir' && request.method === 'POST') {
        await sandbox.mkdir(body.path, { recursive: body.recursive });
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File delete
      if (url.pathname === '/api/file/delete' && request.method === 'DELETE') {
        await sandbox.deleteFile(body.path);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File rename
      if (url.pathname === '/api/file/rename' && request.method === 'POST') {
        await sandbox.renameFile(body.oldPath, body.newPath);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File move
      if (url.pathname === '/api/file/move' && request.method === 'POST') {
        await sandbox.moveFile(body.sourcePath, body.destinationPath);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // List files
      if (url.pathname === '/api/list-files' && request.method === 'POST') {
        const result = await sandbox.listFiles(body.path, body.options);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File exists
      if (url.pathname === '/api/file/exists' && request.method === 'POST') {
        const result = await sandbox.exists(body.path);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Exec and wait for port
      if (
        url.pathname === '/api/exec-and-wait-for-port' &&
        request.method === 'POST'
      ) {
        const { command, port } = body;
        if (!isCommandArgv(command)) {
          return new Response(
            JSON.stringify({ error: 'command must be a non-empty argv array' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const proc = await sandbox.exec(command);
        await proc.waitForPort(port, { timeout: 30000 });
        const status = await proc.status();
        return new Response(
          JSON.stringify({ id: proc.id, state: status.state, ready: true }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Kill running exec
      if (
        url.pathname === '/api/kill-running-exec' &&
        request.method === 'POST'
      ) {
        const { command } = body;
        if (!isCommandArgv(command)) {
          return new Response(
            JSON.stringify({ error: 'command must be a non-empty argv array' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const proc = await sandbox.exec(command);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await proc.kill();
        const exit = await proc.waitForExit();
        return new Response(
          JSON.stringify({ id: proc.id, exitCode: exit.code }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Port exposure
      if (url.pathname === '/api/port/expose' && request.method === 'POST') {
        const hostname = url.hostname + (url.port ? `:${url.port}` : '');
        const preview = await sandbox.exposePort(body.port, {
          name: body.name,
          hostname: hostname,
          token: body.token
        });
        return new Response(JSON.stringify(preview), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Port exposure status
      if (url.pathname === '/api/exposed-ports' && request.method === 'GET') {
        const hostname = url.hostname + (url.port ? `:${url.port}` : '');
        const ports = await sandbox.getExposedPorts(hostname);
        return new Response(JSON.stringify(ports), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname.startsWith('/api/exposed-ports/') &&
        request.method === 'GET'
      ) {
        const pathParts = url.pathname.split('/');
        const port = parseInt(pathParts[3], 10);
        if (!Number.isNaN(port)) {
          const exposed = await sandbox.isPortExposed(port);
          return new Response(JSON.stringify({ exposed, port }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Port unexpose
      if (
        url.pathname.startsWith('/api/exposed-ports/') &&
        request.method === 'DELETE'
      ) {
        const pathParts = url.pathname.split('/');
        const port = parseInt(pathParts[3], 10);
        if (!Number.isNaN(port)) {
          await sandbox.unexposePort(port);
          return new Response(JSON.stringify({ success: true, port }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Tunnels
      if (url.pathname === '/api/tunnel/get' && request.method === 'POST') {
        const info = await sandbox.tunnels.get(body.port, body.options);
        return new Response(JSON.stringify(info), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url.pathname === '/api/tunnel/list' && request.method === 'GET') {
        const tunnels = await sandbox.tunnels.list();
        return new Response(JSON.stringify({ tunnels }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname.startsWith('/api/tunnel/') &&
        request.method === 'DELETE'
      ) {
        const portStr = url.pathname.slice('/api/tunnel/'.length);
        const port = Number.parseInt(portStr, 10);
        if (!Number.isFinite(port)) {
          return new Response(
            JSON.stringify({ error: `Invalid port: ${portStr}` }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        await sandbox.tunnels.destroy(port);
        return new Response(JSON.stringify({ success: true, port }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Environment variables
      if (url.pathname === '/api/env/set' && request.method === 'POST') {
        await sandbox.setEnvVars(body.envVars);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Create Context
      if (
        url.pathname === '/api/code/context/create' &&
        request.method === 'POST'
      ) {
        const context = await sandbox.interpreter.createCodeContext(body);
        return new Response(JSON.stringify(context), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - List Contexts
      if (
        url.pathname === '/api/code/context/list' &&
        request.method === 'GET'
      ) {
        const contexts = await sandbox.interpreter.listCodeContexts();
        return new Response(JSON.stringify(contexts), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Delete Context
      if (
        url.pathname.startsWith('/api/code/context/') &&
        request.method === 'DELETE'
      ) {
        const pathParts = url.pathname.split('/');
        const contextId = pathParts[4]; // /api/code/context/:id
        await sandbox.interpreter.deleteCodeContext(contextId);
        return new Response(JSON.stringify({ success: true, contextId }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Execute Code
      if (url.pathname === '/api/code/execute' && request.method === 'POST') {
        const execution = await sandbox.interpreter.runCode(
          body.code,
          body.options || {}
        );
        return new Response(JSON.stringify(execution), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Code Interpreter - Execute Code with callbacks through the Worker proxy.
      // The callbacks are defined here in the Worker and passed to runCode on the
      // getSandbox() stub, so they cross the Worker->DO boundary as jsRPC stubs.
      if (
        url.pathname === '/api/code/execute/callbacks' &&
        request.method === 'POST'
      ) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const results: unknown[] = [];
        let error: unknown;
        const execution = await sandbox.interpreter.runCode(body.code, {
          ...(body.options || {}),
          onStdout: (message) => {
            stdout.push(message.text);
          },
          onStderr: (message) => {
            stderr.push(message.text);
          },
          onResult: (result) => {
            results.push(result.text ?? null);
          },
          onError: (err) => {
            error = err;
          }
        });
        return new Response(
          JSON.stringify({
            callbacks: { stdout, stderr, results, error },
            execution
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Code Interpreter - Execute Code with Streaming
      if (
        url.pathname === '/api/code/execute/stream' &&
        request.method === 'POST'
      ) {
        const stream = await sandbox.interpreter.runCodeStream(
          body.code,
          body.options || {}
        );
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        });
      }

      // Test-only backup restore fault configuration.
      // The next normal /api/backup/restore call consumes this out-of-band setup.
      if (
        url.pathname === '/api/test/faults/backup-restore' &&
        request.method === 'POST'
      ) {
        if (env.SANDBOX_ENABLE_TEST_HOOKS !== 'true') {
          return new Response(
            JSON.stringify({ error: 'Sandbox test hooks are not enabled' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
          );
        }

        await sandbox.__setBackupRestoreFaultForTesting(body);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Backup - Create backup
      if (url.pathname === '/api/backup/create' && request.method === 'POST') {
        const backup = await sandbox.createBackup(body);
        return new Response(JSON.stringify(backup), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Backup - Restore backup
      if (url.pathname === '/api/backup/restore' && request.method === 'POST') {
        const result = await sandbox.restoreBackup(body);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // File Watch - Stream events via public Sandbox API.
      if (url.pathname === '/api/watch' && request.method === 'POST') {
        const stream = await sandbox.watch(body.path, {
          recursive: body.recursive,
          include: body.include,
          exclude: body.exclude
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        });
      }

      // File Watch - Check retained change state via public Sandbox API.
      if (url.pathname === '/api/watch/check' && request.method === 'POST') {
        const result = await sandbox.checkChanges(body.path, {
          recursive: body.recursive,
          include: body.include,
          exclude: body.exclude,
          since: body.since
        });

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (
        url.pathname === '/api/runtime/retained-log-interruption' &&
        request.method === 'POST'
      ) {
        const proc = await sandbox.exec([
          '/bin/bash',
          '-lc',
          'echo stream-ready; sleep 30'
        ]);
        await proc.waitForLog('stream-ready', { timeout: 10000 });
        const stream = await proc.logs({ replay: false, follow: true });
        const reader = stream.getReader();
        const pendingRead = reader.read().then(
          () => '',
          (error: unknown) =>
            error instanceof Error ? error.name : String(error)
        );
        await sandbox.stop();
        const errorName = await withTimeout(
          pendingRead,
          10000,
          'retained log interruption'
        );
        reader.releaseLock();
        await waitForSandboxStopped(sandbox);
        const recovery = await sandbox.exec(['printf', 'after-interruption']);
        const output = await recovery.output();
        return new Response(
          JSON.stringify({
            interrupted: errorName.length > 0,
            errorName,
            recoveryStdout: decodeOutput(output.stdout)
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (
        url.pathname === '/api/runtime/control-server-exit' &&
        request.method === 'POST'
      ) {
        const proc = await sandbox.exec([
          '/bin/bash',
          '-lc',
          'echo control-stream-ready; sleep 30'
        ]);
        await proc.waitForLog('control-stream-ready', { timeout: 10000 });
        const abortLogs = new AbortController();
        const stream = await proc.logs({
          replay: false,
          follow: true,
          signal: abortLogs.signal
        });
        const reader = stream.getReader();
        const pendingRead = reader.read().then(
          () => ({ originalMessage: 'Stream closed without interruption' }),
          (error: unknown) => {
            const errorRecord = asRecord(error);
            const context = asRecord(errorRecord.context);
            return {
              originalMessage:
                optionalString(context.originalMessage) ??
                (error instanceof Error ? error.message : String(error))
            };
          }
        );

        try {
          const marker = `/tmp/control-server-exit-${crypto.randomUUID()}`;
          const killer = await sandbox.exec([
            '/bin/bash',
            '-lc',
            'echo control-exit-armed; while [ ! -e "$1" ]; do sleep 0.01; done; parent_cmd="$(tr "\\0" " " < /proc/$PPID/cmdline)"; [ "$parent_cmd" = "/container-server/sandbox " ] || { echo "unexpected parent: $parent_cmd" >&2; exit 1; }; kill -KILL "$PPID"',
            'control-server-exit',
            marker
          ]);
          await killer.waitForLog('control-exit-armed', { timeout: 10000 });
          await sandbox.writeFile(marker, 'exit').catch(() => undefined);

          const interruption = await withTimeout(
            pendingRead,
            10000,
            'control server exit interruption'
          );
          const state = await waitForSandboxStopped(sandbox);
          const recovery = await sandbox.exec([
            'printf',
            'after-control-server-exit'
          ]);
          const output = await recovery.output();
          return new Response(
            JSON.stringify({
              stateStatus: state.status,
              interruption,
              recoveryStdout: decodeOutput(output.stdout)
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        } finally {
          abortLogs.abort();
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          await proc.kill().catch(() => undefined);
        }
      }

      if (
        url.pathname === '/api/runtime/concurrent-destroy' &&
        request.method === 'POST'
      ) {
        const results = await Promise.allSettled([
          sandbox.destroy(),
          sandbox.destroy()
        ]);
        const listAfterDestroy = await sandbox.listProcesses();
        return new Response(
          JSON.stringify({
            fulfilled: results.filter((result) => result.status === 'fulfilled')
              .length,
            rejected: results.filter((result) => result.status === 'rejected')
              .length,
            listAfterDestroy
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Cleanup endpoint - destroys the sandbox container
      // This is used by E2E tests to explicitly clean up after each test
      if (url.pathname === '/cleanup' && request.method === 'POST') {
        await sandbox.destroy();
        const response: SuccessWithMessageResponse = {
          success: true,
          message: 'Sandbox destroyed'
        };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Test-only: SIGTERM the container without destroying the DO, so tests
      // can exercise restart-recovery paths (port re-exposure, token
      // persistence). The next RPC on the sandbox will start a fresh
      // container, which triggers onStart().
      if (url.pathname === '/api/container/stop' && request.method === 'POST') {
        await (sandbox as unknown as { stop: () => Promise<void> }).stop();
        const response: SuccessWithMessageResponse = {
          success: true,
          message: 'Container stop requested'
        };
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // PTY: Browser test page for Playwright tests
      if (url.pathname === '/terminal-test') {
        const terminalId =
          url.searchParams.get('terminalId') || `browser-test-${Date.now()}`;
        return new Response(getTerminalTestPage(sandboxId, terminalId), {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      // PTY: WebSocket terminal proxy
      if (
        url.pathname === '/terminal' ||
        url.pathname.startsWith('/terminal/')
      ) {
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader?.toLowerCase() !== 'websocket') {
          return new Response('WebSocket upgrade required', { status: 426 });
        }

        const pathParts = url.pathname.split('/').filter(Boolean);

        const terminalId = pathParts[1];
        const cols = parseInt(url.searchParams.get('cols') || '80', 10);
        const rows = parseInt(url.searchParams.get('rows') || '24', 10);
        if (terminalId) {
          const terminal = await sandbox.getTerminal(terminalId);
          if (!terminal)
            return new Response('Terminal not found', { status: 404 });
          return terminal.connect(request, { cols, rows });
        }
        const terminal = await sandbox.createTerminal({
          command: ['bash'],
          cols,
          rows
        });
        return terminal.connect(request, { cols, rows });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      // Handle SandboxError with proper code and httpStatus.
      //
      // Two paths exist:
      // 1. Direct calls (error has `errorResponse` own property)
      // 2. RPC calls (only `error.name` and `error.message` survive the
      //    Cloudflare RPC boundary — own properties are stripped)
      //
      // We try (1) first, then fall back to (2) using error.name mapping.
      if (isSandboxErrorLike(error)) {
        return new Response(
          JSON.stringify({
            error: error.message,
            code: error.code,
            context: error.context,
            suggestion: error.suggestion
          }),
          {
            status: error.httpStatus ?? 500,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      // RPC fallback: derive HTTP status and error code from error.name
      // Cloudflare RPC strips custom error classes, converting them to generic Error
      // but preserves the class name in the message as "ClassName: actual message"
      if (error instanceof Error) {
        if (isPlatformTransientError(error)) {
          return new Response(
            JSON.stringify({
              error:
                'Sandbox operation was interrupted while the platform reset the sandbox runtime',
              code: 'OPERATION_INTERRUPTED',
              context: {
                reason: 'runtime_replaced',
                operation: 'test-worker.request',
                phase: 'durable_object_call',
                admitted: 'unknown',
                retryable: false
              },
              suggestion:
                'Retry only if the operation is idempotent, or verify sandbox state before retrying.'
            }),
            {
              status: 409,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }

        let errorName = error.name;
        let errorMessage = error.message;

        // Try to extract original error class from message format "ClassName: message"
        if (errorName === 'Error' && error.message.includes(': ')) {
          const colonIndex = error.message.indexOf(': ');
          const potentialClassName = error.message.slice(0, colonIndex);
          // Only use it if it looks like an error class name (PascalCase ending in Error)
          if (/^[A-Z][a-zA-Z]*Error$/.test(potentialClassName)) {
            errorName = potentialClassName;
            errorMessage = error.message.slice(colonIndex + 2);
          }
        }

        const mapping = ERROR_NAME_MAP[errorName];
        if (mapping) {
          return new Response(
            JSON.stringify({
              error: errorMessage,
              code: mapping.code
            }),
            {
              status: mapping.status,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
      }

      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error'
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
};

function getTerminalTestPage(sandboxId: string, terminalId: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Terminal Test</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
  <style>
    body { margin: 0; padding: 20px; background: #1e1e1e; }
    #terminal { width: 100%; height: 400px; }
    #status { color: white; margin-bottom: 10px; font-family: monospace; }
  </style>
</head>
<body>
  <div id="status" data-testid="connection-status">disconnected</div>
  <div id="terminal" data-testid="terminal-container"></div>

  <script type="module">
    import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm';
    import { FitAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm';

    const term = new Terminal({ cursorBlink: true, fontSize: 14 });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    const statusEl = document.getElementById('status');
    const sandboxId = '${sandboxId}';
    const terminalId = '${terminalId}';

    let ws = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;

    function updateStatus(status) {
      statusEl.textContent = status;
      statusEl.dataset.testid = 'connection-status';
    }

    function connect() {
      updateStatus('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + location.host + '/terminal/' + terminalId + '?sandboxId=' + sandboxId;
      
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        term.onData(data => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(data));
          }
        });

        term.onResize(({ cols, rows }) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        });
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
        } else if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'ready') {
              reconnectAttempts = 0;
              updateStatus('connected');
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            } else if (msg.type === 'error') {
              console.error('Server error:', msg.message);
            }
          } catch {}
        }
      };

      ws.onclose = () => {
        updateStatus('disconnected');
        if (reconnectAttempts < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
          reconnectAttempts++;
          setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        console.error('WebSocket error');
      };
    }

    window.addEventListener('resize', () => fitAddon.fit());
    window.terminalConnect = connect;
    window.terminalDisconnect = () => { ws?.close(); ws = null; };
    window.testCloseWs = () => { ws?.close(); };

    connect();
  </script>
</body>
</html>`;
}
