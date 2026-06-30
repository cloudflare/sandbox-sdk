import { type Logger, logCanonicalEvent } from '@repo/shared';
import type {
  CurrentRuntimeIdentity,
  RuntimeIdentity
} from '../current-runtime-identity';
import type { ErrorResponse } from '../errors';
import { CustomDomainRequiredError, ErrorCode } from '../errors';
import { SandboxSecurityError, validatePort } from '../security';
import { forwardPreviewRequest, type PreviewTCPPort } from './forwarding';
import {
  PREVIEW_PROXY_HEADER,
  PREVIEW_PROXY_HEADERS,
  PREVIEW_PROXY_PORT_HEADER,
  PREVIEW_PROXY_SANDBOX_ID_HEADER,
  PREVIEW_PROXY_TOKEN_HEADER
} from './protocol';
import { constructPreviewURL } from './route';
import {
  type CurrentPreviewPort,
  clearActivePreviewPorts,
  PORT_TOKENS_STORAGE_KEY,
  readActivePreviewPorts,
  readPortTokens,
  readPreviewState,
  writeActivePreviewPorts
} from './state';

export type PreviewForwardingContainer = {
  running?: boolean;
  getTcpPort(port: number): PreviewTCPPort;
};

type PreviewURLRuntimeValidation =
  | { status: 'invalid' }
  | {
      status: 'stale';
      reason:
        | 'runtime-not-healthy'
        | 'runtime-not-running'
        | 'missing-runtime-id'
        | 'missing-activation'
        | 'runtime-mismatch'
        | 'token-mismatch';
      containerStatus?: string;
    }
  | { status: 'active'; runtime: RuntimeIdentity };

export interface PreviewServiceDeps {
  storage: DurableObjectStorage;
  logger: Logger;
  currentRuntime: CurrentRuntimeIdentity;
  getContainerState(): Promise<{ status: string }>;
  getForwardingContainer(): PreviewForwardingContainer | undefined;
  ensureRuntimeActiveForPreview(): Promise<RuntimeIdentity>;
  getSandboxName(): string | null;
  getNormalizeID(): boolean;
  beginForward(): () => void;
  renewActivity(): void;
}

export class PreviewService {
  constructor(private readonly deps: PreviewServiceDeps) {}

  isPreviewProxyRequest(request: Request): boolean {
    return request.headers.get(PREVIEW_PROXY_HEADER) === '1';
  }

  async clearActivePreviewPorts(): Promise<void> {
    await clearActivePreviewPorts(this.deps.storage);
  }

  async clearPreviewState(): Promise<void> {
    await this.deps.storage.delete(PORT_TOKENS_STORAGE_KEY);
    await this.clearActivePreviewPorts();
  }

  async exposePort(
    port: number,
    options: { name?: string; hostname: string; token?: string }
  ): Promise<{ url: string; port: number; name?: string }> {
    const exposeStartTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      if (!validatePort(port)) {
        throw new SandboxSecurityError(
          `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
        );
      }

      if (options.hostname.endsWith('.workers.dev')) {
        const errorResponse: ErrorResponse = {
          code: ErrorCode.CUSTOM_DOMAIN_REQUIRED,
          message: `Port exposure requires a custom domain. .workers.dev domains do not support wildcard subdomains required for port proxying.`,
          context: { originalError: options.hostname },
          httpStatus: 400,
          timestamp: new Date().toISOString()
        };
        throw new CustomDomainRequiredError(errorResponse);
      }

      const sandboxName = this.deps.getSandboxName();
      if (!sandboxName) {
        throw new Error(
          'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
        );
      }

      if (options.token !== undefined) {
        this.validateCustomToken(options.token);
      }

      const runtime = await this.deps.ensureRuntimeActiveForPreview();
      await this.deps.currentRuntime.assertActive(runtime);

      const token = await this.deps.storage.transaction(async (txn) => {
        const tokens = await readPortTokens(txn);
        const existingEntry = tokens[port.toString()];
        const nextToken =
          options.token ?? existingEntry?.token ?? this.generatePortToken();

        const existingPort = Object.entries(tokens).find(
          ([p, entry]) => entry.token === nextToken && p !== port.toString()
        );
        if (existingPort) {
          throw new SandboxSecurityError(
            `Token '${nextToken}' is already in use by port ${existingPort[0]}. Please use a different token.`
          );
        }

        const activations = await readActivePreviewPorts(txn);

        tokens[port.toString()] = { token: nextToken, name: options.name };
        activations[port.toString()] = runtime.scope({ token: nextToken });
        await Promise.all([
          txn.put(PORT_TOKENS_STORAGE_KEY, tokens),
          writeActivePreviewPorts(activations, txn)
        ]);

        return nextToken;
      });

      await this.deps.currentRuntime.assertActive(runtime);

      const url = this.constructPreviewURL(
        port,
        sandboxName,
        options.hostname,
        token
      );

      outcome = 'success';

      return {
        url,
        port,
        name: options.name
      };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.deps.logger, {
        event: 'port.expose',
        outcome,
        port,
        durationMs: Date.now() - exposeStartTime,
        name: options.name,
        hostname: options.hostname,
        error: caughtError
      });
    }
  }

  async unexposePort(port: number): Promise<void> {
    const unexposeStartTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      if (!validatePort(port)) {
        throw new SandboxSecurityError(
          `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
        );
      }

      await this.deps.storage.transaction(async (txn) => {
        const tokens = await readPortTokens(txn);
        if (tokens[port.toString()]) {
          delete tokens[port.toString()];
          await txn.put(PORT_TOKENS_STORAGE_KEY, tokens);
        }

        const activations = await readActivePreviewPorts(txn);
        if (activations[port.toString()]) {
          delete activations[port.toString()];
          await writeActivePreviewPorts(activations, txn);
        }
      });

      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.deps.logger, {
        event: 'port.unexpose',
        outcome,
        port,
        durationMs: Date.now() - unexposeStartTime,
        error: caughtError
      });
    }
  }

  async getExposedPorts(
    hostname: string
  ): Promise<Array<{ url: string; port: number; status: 'active' }>> {
    const sandboxName = this.deps.getSandboxName();
    if (!sandboxName) {
      throw new Error(
        'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
      );
    }

    const activePorts = await this.getCurrentPreviewPorts();
    return activePorts.map(({ port, entry }) => ({
      url: this.constructPreviewURL(port, sandboxName, hostname, entry.token),
      port,
      status: 'active' as const
    }));
  }

  async isPortExposed(port: number): Promise<boolean> {
    if (!validatePort(port)) {
      return false;
    }

    const activePorts = await this.getCurrentPreviewPorts();
    return activePorts.some((activePort) => activePort.port === port);
  }

  async validatePortToken(port: number, token: string): Promise<boolean> {
    const tokens = await readPortTokens(this.deps.storage);
    const entry = tokens[port.toString()];
    if (!entry) {
      return false;
    }

    return this.previewTokensMatch(entry.token, token);
  }

  async proxyPreviewRequest(request: Request): Promise<Response> {
    const portValue = request.headers.get(PREVIEW_PROXY_PORT_HEADER);
    const token = request.headers.get(PREVIEW_PROXY_TOKEN_HEADER);
    const sandboxId = request.headers.get(PREVIEW_PROXY_SANDBOX_ID_HEADER);
    const port =
      portValue === null ? Number.NaN : Number.parseInt(portValue, 10);

    if (!Number.isFinite(port) || !validatePort(port) || !token || !sandboxId) {
      return this.invalidPreviewTokenResponse();
    }

    const proxyRequest = this.buildPreviewProxyRequest(
      request,
      port,
      sandboxId
    );

    const validation = await this.validatePreviewURLForRuntime(port, token);
    if (validation.status === 'invalid') {
      return this.invalidPreviewTokenResponse();
    }

    if (validation.status === 'stale') {
      this.deps.logger.warn('Stale preview URL blocked', {
        port,
        sandboxId,
        containerStatus: validation.containerStatus,
        reason: validation.reason,
        method: request.method
      });
      return this.stalePreviewURLResponse();
    }

    return await this.fetchPreviewIfRunning(
      proxyRequest,
      port,
      validation.runtime
    );
  }

  private constructPreviewURL(
    port: number,
    sandboxId: string,
    hostname: string,
    token: string
  ): string {
    return constructPreviewURL({
      port,
      sandboxId,
      hostname,
      token,
      effectiveId: this.deps.getSandboxName() || sandboxId,
      normalizeId: this.deps.getNormalizeID()
    });
  }

  private invalidPreviewTokenResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Access denied: Invalid token or port not exposed',
        code: 'INVALID_TOKEN'
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }

  private stalePreviewURLResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Preview URL is stale because the sandbox runtime is not active',
        code: 'STALE_PREVIEW_URL'
      }),
      {
        status: 410,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }

  private buildPreviewProxyRequest(
    request: Request,
    port: number,
    sandboxId: string
  ): Request {
    const url = new URL(request.url);
    const proxyURL = `http://localhost:${port}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    for (const header of PREVIEW_PROXY_HEADERS) {
      headers.delete(header);
    }
    headers.set('X-Original-URL', request.url);
    headers.set('X-Forwarded-Host', url.hostname);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
    headers.set('X-Sandbox-Name', this.deps.getSandboxName() ?? sandboxId);

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return new Request(request, {
        headers,
        redirect: 'manual'
      });
    }

    return new Request(proxyURL, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error - duplex required for body streaming in modern runtimes
      duplex: 'half',
      redirect: 'manual'
    });
  }

  private async fetchPreviewIfRunning(
    request: Request,
    port: number,
    runtime: RuntimeIdentity
  ): Promise<Response> {
    const container = this.deps.getForwardingContainer();
    const state = await this.deps.getContainerState();

    if (!container?.running || state.status !== 'healthy') {
      return this.stalePreviewURLResponse();
    }

    if (!(await this.deps.currentRuntime.isActive(runtime))) {
      return this.stalePreviewURLResponse();
    }

    const tcpPort = container.getTcpPort(port);

    const result = await forwardPreviewRequest(tcpPort, request, {
      beginForward: () => this.deps.beginForward(),
      renewActivity: () => this.deps.renewActivity()
    });

    if (result.status === 'network-lost') {
      if (!(await this.deps.currentRuntime.isActive(runtime))) {
        return this.stalePreviewURLResponse();
      }

      return new Response('Container suddenly disconnected, try again', {
        status: 500
      });
    }

    return result.response;
  }

  private async validatePreviewURLForRuntime(
    port: number,
    token: string
  ): Promise<PreviewURLRuntimeValidation> {
    const containerState = await this.deps.getContainerState();
    const containerRunning =
      this.deps.getForwardingContainer()?.running === true;
    const { tokens, activations, runtime } =
      await this.deps.storage.transaction(async (txn) => {
        const [previewState, runtime] = await Promise.all([
          readPreviewState(txn),
          this.deps.currentRuntime.getStored(txn)
        ]);
        return { ...previewState, runtime };
      });

    const entry = tokens[port.toString()];
    if (!entry) {
      return { status: 'invalid' };
    }

    const tokenMatches = this.previewTokensMatch(entry.token, token);
    if (!tokenMatches) {
      return { status: 'invalid' };
    }

    if (containerState.status !== 'healthy') {
      return {
        status: 'stale',
        reason: 'runtime-not-healthy',
        containerStatus: containerState.status
      };
    }

    if (!containerRunning) {
      return {
        status: 'stale',
        reason: 'runtime-not-running',
        containerStatus: containerState.status
      };
    }

    if (!runtime) {
      return {
        status: 'stale',
        reason: 'missing-runtime-id',
        containerStatus: containerState.status
      };
    }

    const activation = activations[port.toString()];
    if (!activation) {
      return {
        status: 'stale',
        reason: 'missing-activation',
        containerStatus: containerState.status
      };
    }

    if (!runtime.owns(activation)) {
      return {
        status: 'stale',
        reason: 'runtime-mismatch',
        containerStatus: containerState.status
      };
    }

    const activationTokenMatches = this.previewTokensMatch(
      activation.token,
      token
    );
    if (!activationTokenMatches) {
      this.deps.logger.warn('Preview URL activation token mismatch', {
        port,
        runtimeIdentityID: runtime.id
      });
      return {
        status: 'stale',
        reason: 'token-mismatch',
        containerStatus: containerState.status
      };
    }

    return { status: 'active', runtime };
  }

  private async getCurrentPreviewPorts(): Promise<CurrentPreviewPort[]> {
    const containerState = await this.deps.getContainerState();
    const containerRunning =
      this.deps.getForwardingContainer()?.running === true;
    const { tokens, activations, runtime } =
      await this.deps.storage.transaction(async (txn) => {
        const [previewState, runtime] = await Promise.all([
          readPreviewState(txn),
          this.deps.currentRuntime.getStored(txn)
        ]);
        return { ...previewState, runtime };
      });

    if (containerState.status !== 'healthy' || !containerRunning || !runtime) {
      return [];
    }

    const activePorts: CurrentPreviewPort[] = [];

    for (const [portKey, activation] of Object.entries(activations)) {
      const port = Number.parseInt(portKey, 10);
      const entry = tokens[portKey];
      if (!entry || !Number.isInteger(port) || !validatePort(port)) {
        continue;
      }

      if (!runtime.owns(activation)) {
        continue;
      }

      if (!this.previewTokensMatch(entry.token, activation.token)) {
        continue;
      }

      activePorts.push({ port, entry });
    }

    return activePorts.sort((a, b) => a.port - b.port);
  }

  private previewTokensMatch(expected: string, actual: string): boolean {
    const encoder = new TextEncoder();
    const a = encoder.encode(expected);
    const b = encoder.encode(actual);

    try {
      return (
        crypto.subtle as SubtleCrypto & {
          timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
        }
      ).timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private validateCustomToken(token: string): void {
    if (token.length === 0) {
      throw new SandboxSecurityError(`Custom token cannot be empty.`);
    }

    if (token.length > 16) {
      throw new SandboxSecurityError(
        `Custom token too long. Maximum 16 characters allowed. Received: ${token.length} characters.`
      );
    }

    if (!/^[a-z0-9_]+$/.test(token)) {
      throw new SandboxSecurityError(
        `Custom token must contain only lowercase letters (a-z), numbers (0-9), and underscores (_). Invalid token provided.`
      );
    }
  }

  private generatePortToken(): string {
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);

    const base64 = btoa(String.fromCharCode(...array));
    return base64
      .replace(/\+/g, '_')
      .replace(/\//g, '_')
      .replace(/=/g, '')
      .toLowerCase();
  }
}
