/**
 * Runtime shim for the bridge's capnweb RPC interface.
 *
 * Exposed as the local main of every `GET /v1/rpc` WebSocket session.
 * One method, `sandbox(id?)`, validates the ID (or generates a fresh one)
 * and returns a per-sandbox `SandboxRPCAPI` stub. Each domain on that
 * stub forwards to the bridge's `BridgeSandbox` proxy.
 *
 * Sandbox-id validation lives here — not in HTTP middleware — so the wire
 * path stays sandbox-agnostic and a single WebSocket can address many
 * sandboxes via repeated `sandbox(id)` calls. Container resolution is
 * direct (no warm pool) for now — this endpoint is experimental and the
 * container lifecycle is owned by the underlying `getSandbox()` proxy.
 */

import { newWorkersWebSocketRpcResponse, RpcTarget } from 'capnweb';
import type { Sandbox } from '../sandbox';
import type { BridgeSandbox } from './bridge-sandbox';
import { getBridgeSandbox } from './bridge-sandbox';
import { errorJson, generateSandboxId, isValidSandboxId } from './helpers';
import { BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX } from './rpc-types';
import type { BridgeEnv } from './types';

/** Throw a stable error for runtime-stubbed methods. */
function notImplemented(method: string): never {
  const err = new Error(`${method} is not yet implemented over the bridge RPC`);
  (err as Error & { code?: string }).code = 'not_implemented';
  throw err;
}

/**
 * Per-connection context shared with every domain shim. Captured at
 * upgrade time so each RPC call sees the same hostname (used for
 * preview-URL synthesis) regardless of which call goes first.
 */
export interface BridgeRPCContext {
  /** Public hostname used to build preview URLs from `ports.exposePort()`. */
  hostname: string;
}

/**
 * Dependencies the top-level RPC API needs from the bridge route layer.
 * Captured at upgrade time so the RPC handler doesn't have to thread
 * Hono context, env, or DO bindings through every shim method.
 */
export interface BridgeRPCDeps {
  /** Sandbox Durable Object namespace, used to resolve a `BridgeSandbox`. */
  sandboxNs: DurableObjectNamespace<Sandbox<any>>;
  /** Per-connection context shared with every domain shim. */
  context: BridgeRPCContext;
}

/**
 * Top-level RPC target. Holds the dependencies needed to resolve a
 * sandbox and hands out per-sandbox `SandboxRPCAPI` stubs.
 */
export class BridgeRPCAPI extends RpcTarget {
  readonly #deps: BridgeRPCDeps;

  constructor(deps: BridgeRPCDeps) {
    super();
    this.#deps = deps;
  }

  /**
   * Resolve a sandbox by ID and return its RPC stub.
   *
   * If `sandboxId` is omitted, a fresh ID is generated (16 random bytes,
   * base32-encoded — the same shape `POST /v1/sandbox` returns). The
   * returned `SandboxRPCAPI` carries the resolved id on its `id` getter
   * so callers can read back a generated value.
   */
  async sandbox(sandboxId?: string): Promise<SandboxRPCAPI> {
    const resolvedId = sandboxId ?? generateSandboxId();
    if (!isValidSandboxId(resolvedId)) {
      const err = new Error('Invalid sandbox ID format');
      (err as Error & { code?: string }).code = 'invalid_request';
      throw err;
    }
    const sandbox = getBridgeSandbox(this.#deps.sandboxNs, resolvedId);
    return new SandboxRPCAPI(resolvedId, sandbox, this.#deps.context);
  }
}

/**
 * Per-sandbox RPC target. All ten domains hang off this; each method
 * forwards to the resolved `BridgeSandbox` proxy.
 */
export class SandboxRPCAPI extends RpcTarget {
  readonly #id: string;
  readonly #sandbox: BridgeSandbox;
  readonly #context: BridgeRPCContext;

  constructor(id: string, sandbox: BridgeSandbox, context: BridgeRPCContext) {
    super();
    this.#id = id;
    this.#sandbox = sandbox;
    this.#context = context;
  }

  /** The sandbox ID this stub is bound to. */
  get id(): string {
    return this.#id;
  }

  get commands(): CommandsBridgeRPC {
    return new CommandsBridgeRPC(this.#sandbox);
  }
  get files(): FilesBridgeRPC {
    return new FilesBridgeRPC(this.#sandbox);
  }
  get processes(): ProcessesBridgeRPC {
    return new ProcessesBridgeRPC(this.#sandbox);
  }
  get ports(): PortsBridgeRPC {
    return new PortsBridgeRPC(this.#sandbox, this.#context);
  }
  get git(): GitBridgeRPC {
    return new GitBridgeRPC(this.#sandbox);
  }
  get interpreter(): InterpreterBridgeRPC {
    return new InterpreterBridgeRPC(this.#sandbox);
  }
  get utils(): UtilsBridgeRPC {
    return new UtilsBridgeRPC(this.#sandbox);
  }
  get backup(): BackupBridgeRPC {
    return new BackupBridgeRPC(this.#sandbox);
  }
  get desktop(): DesktopBridgeRPC {
    return new DesktopBridgeRPC(this.#sandbox);
  }
  get watch(): WatchBridgeRPC {
    return new WatchBridgeRPC(this.#sandbox);
  }
}

/**
 * Configuration for the standalone RPC route, registered by the Hono app
 * at `${apiPrefix}/rpc` (default `/v1/rpc`).
 */
export interface RpcRouteConfig {
  /** DO binding name for the Sandbox namespace. */
  sandboxBinding: string;
}

/**
 * Validate a Sec-WebSocket-Protocol bearer token against `SANDBOX_API_KEY`.
 *
 * Returns `{ ok: true, selectedProtocol }` if auth passes (the protocol is
 * echoed on the 101 to complete the browser handshake), or `{ ok: false,
 * response }` with a 401 when the token is missing or wrong. Auth-disabled
 * deployments (no `SANDBOX_API_KEY`) always pass; the protocol is echoed
 * back if the client supplied one.
 */
export function authenticateRpcUpgrade(
  request: Request,
  token: string | undefined
):
  | { ok: true; selectedProtocol: string | undefined }
  | { ok: false; response: Response } {
  const protocolHeader = request.headers.get('Sec-WebSocket-Protocol') ?? '';
  const bearerProtocol = protocolHeader
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX));
  if (!token) {
    return { ok: true, selectedProtocol: bearerProtocol };
  }
  if (!bearerProtocol) {
    return {
      ok: false,
      response: errorJson('Unauthorized', 'unauthorized', 401)
    };
  }
  const provided = bearerProtocol.slice(
    BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX.length
  );
  if (provided !== token) {
    return {
      ok: false,
      response: errorJson('Unauthorized', 'unauthorized', 401)
    };
  }
  return { ok: true, selectedProtocol: bearerProtocol };
}

/**
 * Handle a request to the bridge's `/v1/rpc` endpoint.
 *
 * Validates the WebSocket upgrade and the `Sec-WebSocket-Protocol` bearer
 * token, then starts a capnweb session whose local main is a
 * `BridgeRPCAPI` bound to this connection's deps + context.
 */
export function handleRpcUpgrade(
  request: Request,
  env: BridgeEnv,
  config: RpcRouteConfig
): Response {
  const upgrade = request.headers.get('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return errorJson('WebSocket upgrade required', 'invalid_request', 400);
  }

  const auth = authenticateRpcUpgrade(
    request,
    env.SANDBOX_API_KEY as string | undefined
  );
  if (!auth.ok) return auth.response;

  const sandboxNs = env[config.sandboxBinding] as
    | DurableObjectNamespace<Sandbox<unknown>>
    | undefined;
  if (!sandboxNs) {
    return errorJson(
      `Bridge binding missing: ${config.sandboxBinding}`,
      'config_error',
      503
    );
  }
  const hostname =
    (env.BRIDGE_PREVIEW_HOSTNAME as string | undefined) ||
    request.headers.get('Host') ||
    new URL(request.url).host;

  const localMain = new BridgeRPCAPI({
    sandboxNs,
    context: { hostname }
  });
  const response = newWorkersWebSocketRpcResponse(request, localMain);
  if (auth.selectedProtocol) {
    response.headers.set('Sec-WebSocket-Protocol', auth.selectedProtocol);
  }
  return response;
}

class CommandsBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  /**
   * Run a command in the given session and return the final result.
   *
   * Translates the wire-shape options (`timeoutMs`) to the SDK's
   * `ExecOptions` shape (`timeout`) so callers don't have to know which
   * layer they're talking to.
   */
  async execute(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
    }
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    const result = await session.exec(command, {
      timeout: options?.timeoutMs,
      env: options?.env,
      cwd: options?.cwd
    });
    return {
      success: result.success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      command: result.command,
      timestamp: result.timestamp
    };
  }
  /**
   * Stream a command's output as a `ReadableStream<Uint8Array>` of SSE-encoded
   * `ExecEvent`s, identical to the wire format produced by
   * `ISandbox.execStream`. Capnweb forwards `ReadableStream` natively, so the
   * bridge is a pure pass-through — the client decodes with `parseSSEStream`.
   */
  async executeStream(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
    }
  ): Promise<ReadableStream<Uint8Array>> {
    const session = await this.#sandbox.getSession(sessionId);
    return session.execStream(command, {
      timeout: options?.timeoutMs,
      env: options?.env,
      cwd: options?.cwd
    });
  }
}

class FilesBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  async readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: string }
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.readFile(path, options);
  }
  async readFileStream(
    path: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>> {
    const session = await this.#sandbox.getSession(sessionId);
    return session.readFileStream(path);
  }
  async writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string; permissions?: string }
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.writeFile(path, content, options);
  }
  /**
   * Capnweb forwards `ReadableStream` natively, so a streamed write is just
   * `session.writeFile(path, stream, options)` — the underlying SDK already
   * accepts `string | ReadableStream` for `content`.
   */
  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    sessionId: string
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.writeFile(path, stream);
  }
  async deleteFile(path: string, sessionId: string) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.deleteFile(path);
  }
  async renameFile(oldPath: string, newPath: string, sessionId: string) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.renameFile(oldPath, newPath);
  }
  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId: string
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.moveFile(sourcePath, destinationPath);
  }
  async mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.mkdir(path, options);
  }
  async listFiles(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean; includeHidden?: boolean }
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.listFiles(path, options);
  }
  async exists(path: string, sessionId: string) {
    const session = await this.#sandbox.getSession(sessionId);
    return session.exists(path);
  }
}

/**
 * Flatten an SDK `Process` (rich object with methods) into the plain
 * DTO shape used on the wire. Capnweb refuses to serialize objects with
 * methods, so we only emit the fields declared in `SandboxProcessesAPI`.
 */
function flattenProcess(p: any) {
  return {
    id: p.id as string,
    pid: p.pid as number | undefined,
    command: p.command as string,
    status: p.status as string,
    startTime:
      p.startTime instanceof Date
        ? p.startTime.toISOString()
        : String(p.startTime),
    endTime:
      p.endTime instanceof Date
        ? p.endTime.toISOString()
        : (p.endTime as string | undefined),
    exitCode: p.exitCode as number | undefined
  };
}

function nowIsoTimestamp() {
  return new Date().toISOString();
}

class ProcessesBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  /**
   * Start a background process inside the given session. Translates the
   * wire option `timeoutMs` to the SDK's `timeout` and flattens the rich
   * `Process` return into a plain `ProcessStartResult` DTO.
   */
  async startProcess(
    command: string,
    sessionId: string,
    options?: { processId?: string; timeoutMs?: number }
  ) {
    const session = await this.#sandbox.getSession(sessionId);
    const process = await session.startProcess(command, {
      processId: options?.processId,
      timeout: options?.timeoutMs
    });
    return {
      success: true,
      processId: process.id,
      pid: process.pid,
      command: process.command,
      timestamp: nowIsoTimestamp()
    };
  }
  async listProcesses() {
    const processes = await this.#sandbox.listProcesses();
    return {
      success: true,
      processes: processes.map(flattenProcess),
      timestamp: nowIsoTimestamp()
    };
  }
  async getProcess(id: string) {
    const process = await this.#sandbox.getProcess(id);
    if (!process) {
      const err = new Error(`process not found: ${id}`);
      (err as Error & { code?: string }).code = 'process_not_found';
      throw err;
    }
    return {
      success: true,
      process: flattenProcess(process),
      timestamp: nowIsoTimestamp()
    };
  }
  async killProcess(id: string) {
    await this.#sandbox.killProcess(id);
    return { success: true, processId: id, timestamp: nowIsoTimestamp() };
  }
  async killAllProcesses() {
    const cleanedCount = await this.#sandbox.killAllProcesses();
    return { success: true, cleanedCount, timestamp: nowIsoTimestamp() };
  }
  async getProcessLogs(id: string) {
    const r = await this.#sandbox.getProcessLogs(id);
    return {
      success: true,
      processId: r.processId,
      stdout: r.stdout,
      stderr: r.stderr,
      timestamp: nowIsoTimestamp()
    };
  }
  async streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>> {
    return this.#sandbox.streamProcessLogs(id);
  }
}

class PortsBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  readonly #context: BridgeRPCContext;
  constructor(sandbox: BridgeSandbox, context: BridgeRPCContext) {
    super();
    this.#sandbox = sandbox;
    this.#context = context;
  }
  /**
   * Expose a port and return the synthesized preview URL. The bridge
   * captures its public hostname at upgrade time and injects it here so
   * RPC callers don't need to know it. The wire shape's `name` parameter
   * matches `Sandbox.exposePort`'s `options.name`.
   */
  async exposePort(port: number, _sessionId: string, name?: string) {
    const result = await this.#sandbox.exposePort(port, {
      hostname: this.#context.hostname,
      name
    });
    return {
      success: true,
      port: result.port,
      url: result.url,
      timestamp: nowIsoTimestamp()
    };
  }
  async unexposePort(port: number, _sessionId: string) {
    await this.#sandbox.unexposePort(port);
    return { success: true, port, timestamp: nowIsoTimestamp() };
  }
  async getExposedPorts(_sessionId: string) {
    const ports = await this.#sandbox.getExposedPorts(this.#context.hostname);
    return {
      success: true,
      ports: ports.map((p) => ({
        port: p.port,
        url: p.url,
        // Sandbox.getExposedPorts only returns active ports.
        status: 'active' as const
      })),
      timestamp: nowIsoTimestamp()
    };
  }
  /**
   * Streaming port watch — the container emits `PortWatchEvent` SSE frames
   * as the port transitions through `watching` → `ready`/`process_exited`.
   * Capnweb forwards `ReadableStream` natively, so the bridge is a pass-through.
   */
  watchPort(request: {
    port: number;
    mode: 'http' | 'tcp';
    path?: string;
    statusMin?: number;
    statusMax?: number;
    processId?: string;
    interval?: number;
  }): Promise<ReadableStream<Uint8Array>> {
    return this.#sandbox.client.ports.watchPort(request);
  }
}

class GitBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  /**
   * Clone a repo into the sandbox. Translates the wire option `timeoutMs`
   * to the SDK's `cloneTimeoutMs`.
   */
  checkout(
    repoUrl: string,
    sessionId: string,
    options?: {
      branch?: string;
      targetDir?: string;
      depth?: number;
      timeoutMs?: number;
    }
  ) {
    return this.#sandbox.gitCheckout(repoUrl, {
      sessionId,
      branch: options?.branch,
      targetDir: options?.targetDir,
      depth: options?.depth,
      cloneTimeoutMs: options?.timeoutMs
    });
  }
}

class InterpreterBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  createCodeContext(options?: any) {
    return this.#sandbox.client.interpreter.createCodeContext(options);
  }
  streamCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#sandbox.client.interpreter.streamCode(
      contextId,
      code,
      language
    );
  }
  /**
   * Run code in the given context, piping output through the supplied
   * callbacks. Capnweb forwards the callback functions as RPC stubs, so
   * each `onStdout`/`onStderr`/`onResult`/`onError` invocation inside the
   * SDK is piped back across the WebSocket to the client.
   */
  runCodeStream(
    contextId: string | undefined,
    code: string,
    language: string | undefined,
    callbacks: {
      onStdout?: (output: any) => void | Promise<void>;
      onStderr?: (output: any) => void | Promise<void>;
      onResult?: (result: any) => void | Promise<void>;
      onError?: (error: any) => void | Promise<void>;
    },
    timeoutMs?: number
  ): Promise<void> {
    return this.#sandbox.client.interpreter.runCodeStream(
      contextId,
      code,
      language,
      callbacks,
      timeoutMs
    );
  }
  listCodeContexts() {
    return this.#sandbox.client.interpreter.listCodeContexts();
  }
  deleteCodeContext(contextId: string) {
    return this.#sandbox.client.interpreter.deleteCodeContext(contextId);
  }
}

class UtilsBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  /**
   * Constant 'pong'. Wired in v1 as a cheap liveness probe so integration
   * tests can verify the wire end-to-end without touching the container.
   * Does not delegate to `client.utils.ping` (which would require a live
   * container).
   */
  ping(): string {
    return 'pong';
  }
  getVersion(): Promise<string> {
    return this.#sandbox.client.utils.getVersion();
  }
  getCommands(): Promise<string[]> {
    return this.#sandbox.client.utils.getCommands();
  }
  createSession(options: {
    id: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  }) {
    return this.#sandbox.client.utils.createSession(options);
  }
  deleteSession(sessionId: string) {
    return this.#sandbox.client.utils.deleteSession(sessionId);
  }
  listSessions() {
    return this.#sandbox.client.utils.listSessions();
  }
}

class BackupBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  /**
   * Create a tar archive of `dir` at `archivePath` inside the sandbox.
   * Delegates to the low-level container archive API rather than to
   * `Sandbox.createBackup` (the higher-level R2-backed snapshot system),
   * matching the wire shape declared in `SandboxBackupAPI`.
   */
  createArchive(
    dir: string,
    archivePath: string,
    sessionId: string,
    options?: { excludes?: string[]; gitignore?: boolean }
  ) {
    return this.#sandbox.client.backup.createArchive(
      dir,
      archivePath,
      sessionId,
      options
    );
  }
  restoreArchive(dir: string, archivePath: string, sessionId: string) {
    return this.#sandbox.client.backup.restoreArchive(
      dir,
      archivePath,
      sessionId
    );
  }
}

class DesktopBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  // The shim forwards every desktop method to `sandbox.desktop.METHOD(...)`.
  // `sandbox.desktop` is itself a Proxy installed by `getSandbox()` that
  // dispatches each method through `callDesktop()` against the DO. We only
  // need to type-narrow the args/return for the wire surface.
  //
  start(options?: any) {
    return this.#sandbox.desktop.start(options);
  }
  stop() {
    return this.#sandbox.desktop.stop();
  }
  status() {
    return this.#sandbox.desktop.status();
  }
  screenshot(options?: any) {
    return this.#sandbox.desktop.screenshot(options);
  }
  screenshotRegion(request: any) {
    return this.#sandbox.desktop.screenshotRegion(request);
  }
  click(x: number, y: number, options?: any) {
    return this.#sandbox.desktop.click(x, y, options);
  }
  doubleClick(x: number, y: number, options?: any) {
    return this.#sandbox.desktop.doubleClick(x, y, options);
  }
  tripleClick(x: number, y: number, options?: any) {
    return this.#sandbox.desktop.tripleClick(x, y, options);
  }
  rightClick(x: number, y: number) {
    return this.#sandbox.desktop.rightClick(x, y);
  }
  middleClick(x: number, y: number) {
    return this.#sandbox.desktop.middleClick(x, y);
  }
  mouseDown(x?: number, y?: number, options?: any) {
    return this.#sandbox.desktop.mouseDown(x, y, options);
  }
  mouseUp(x?: number, y?: number, options?: any) {
    return this.#sandbox.desktop.mouseUp(x, y, options);
  }
  moveMouse(x: number, y: number) {
    return this.#sandbox.desktop.moveMouse(x, y);
  }
  drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: any
  ) {
    return this.#sandbox.desktop.drag(startX, startY, endX, endY, options);
  }
  scroll(x: number, y: number, direction: any, amount?: number) {
    return this.#sandbox.desktop.scroll(x, y, direction, amount);
  }
  getCursorPosition() {
    return this.#sandbox.desktop.getCursorPosition();
  }
  type(text: string, options?: any) {
    return this.#sandbox.desktop.type(text, options);
  }
  press(key: string) {
    return this.#sandbox.desktop.press(key);
  }
  keyDown(key: string) {
    return this.#sandbox.desktop.keyDown(key);
  }
  keyUp(key: string) {
    return this.#sandbox.desktop.keyUp(key);
  }
  getScreenSize() {
    return this.#sandbox.desktop.getScreenSize();
  }
  getProcessStatus(name: string) {
    return this.#sandbox.desktop.getProcessStatus(name);
  }
}

class WatchBridgeRPC extends RpcTarget {
  readonly #sandbox: BridgeSandbox;
  constructor(sandbox: BridgeSandbox) {
    super();
    this.#sandbox = sandbox;
  }
  /**
   * Stream filesystem-watch events as a `ReadableStream`. Forwards through
   * `Sandbox.watch(path, options)`; the wire-shape `WatchRequest` keeps the
   * fields together for convenience.
   */
  watch(request: {
    path: string;
    recursive?: boolean;
    events?: any[];
    include?: string[];
    exclude?: string[];
    sessionId?: string;
  }): Promise<ReadableStream<Uint8Array>> {
    const { path, ...rest } = request;
    return this.#sandbox.watch(path, rest);
  }
  checkChanges(request: {
    path: string;
    recursive?: boolean;
    include?: string[];
    exclude?: string[];
    since?: string;
    sessionId?: string;
  }) {
    const { path, ...rest } = request;
    return this.#sandbox.checkChanges(path, rest);
  }
}
