import { type Logger, logCanonicalEvent } from '@repo/shared';
import type {
  CurrentRuntimeIdentity,
  RuntimeIdentity
} from '../current-runtime-identity';
import type { ErrorResponse } from '../errors';
import { CustomDomainRequiredError, ErrorCode } from '../errors';
import { SandboxSecurityError, validatePort } from '../security';
import { forwardPreviewRequest, type PreviewTCPPort } from './forwarding';
import { readPreviewProxyMetadata } from './protocol';
import { buildPreviewProxyRequest } from './proxy-request';
import { constructPreviewURL } from './route';
import {
  type CurrentPreviewPort,
  clearActivePreviewPorts,
  PORT_TOKENS_STORAGE_KEY,
  type PortTokenEntry,
  type PreviewPortActivations,
  readActivePreviewPorts,
  readPortTokens,
  readPreviewState,
  writeActivePreviewPorts
} from './state';
import {
  assertValidCustomPreviewToken,
  generatePreviewToken,
  previewTokensMatch
} from './token';

export type PreviewForwardingContainer = {
  running?: boolean;
  getTcpPort(port: number): PreviewTCPPort;
};

type StalePreviewRuntime = {
  status: 'stale';
  reason:
    | 'runtime-not-healthy'
    | 'runtime-not-running'
    | 'missing-runtime-id'
    | 'missing-activation'
    | 'runtime-mismatch'
    | 'token-mismatch';
  containerStatus?: string;
};

type PreviewURLRuntimeValidation =
  | { status: 'invalid' }
  | StalePreviewRuntime
  | { status: 'active'; runtime: RuntimeIdentity };

type PreviewRuntimeAvailability =
  | StalePreviewRuntime
  | { status: 'active'; runtime: RuntimeIdentity };

type PreviewRuntimeSnapshot = {
  containerStatus: string;
  containerRunning: boolean;
  tokens: Record<string, PortTokenEntry>;
  activations: PreviewPortActivations;
  runtime: RuntimeIdentity | null;
};

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

  async clearActivePreviewPorts(): Promise<void> {
    await clearActivePreviewPorts(this.deps.storage);
  }

  async clearPreviewState(): Promise<void> {
    await this.deps.storage.transaction(async (txn) => {
      await txn.delete(PORT_TOKENS_STORAGE_KEY);
      await clearActivePreviewPorts(txn);
    });
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
        assertValidCustomPreviewToken(options.token);
      }

      const runtime = await this.deps.ensureRuntimeActiveForPreview();
      await this.deps.currentRuntime.assertActive(runtime);

      const token = await this.deps.storage.transaction(async (txn) => {
        const tokens = await readPortTokens(txn);
        const existingEntry = tokens[port.toString()];
        const nextToken =
          options.token ?? existingEntry?.token ?? generatePreviewToken();

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

      const url = constructPreviewURL({
        port,
        sandboxId: sandboxName,
        effectiveId: sandboxName,
        hostname: options.hostname,
        token,
        normalizeId: this.deps.getNormalizeID()
      });

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
      url: constructPreviewURL({
        port,
        sandboxId: sandboxName,
        effectiveId: sandboxName,
        hostname,
        token: entry.token,
        normalizeId: this.deps.getNormalizeID()
      }),
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

    return previewTokensMatch(entry.token, token);
  }

  async proxyPreviewRequest(request: Request): Promise<Response> {
    const target = readPreviewProxyMetadata(request);
    if (!target) {
      return this.invalidPreviewTokenResponse();
    }

    const { port, token, sandboxId } = target;
    const proxyRequest = buildPreviewProxyRequest(request, {
      port,
      sandboxId,
      sandboxName: this.deps.getSandboxName()
    });

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
    const snapshot = await this.readRuntimeSnapshot();
    const entry = snapshot.tokens[port.toString()];
    if (!entry) {
      return { status: 'invalid' };
    }

    const tokenMatches = previewTokensMatch(entry.token, token);
    if (!tokenMatches) {
      return { status: 'invalid' };
    }

    const availability = this.getRuntimeAvailability(snapshot);
    if (availability.status === 'stale') {
      return availability;
    }

    const activation = snapshot.activations[port.toString()];
    if (!activation) {
      return {
        status: 'stale',
        reason: 'missing-activation',
        containerStatus: snapshot.containerStatus
      };
    }

    if (!availability.runtime.owns(activation)) {
      return {
        status: 'stale',
        reason: 'runtime-mismatch',
        containerStatus: snapshot.containerStatus
      };
    }

    const activationTokenMatches = previewTokensMatch(activation.token, token);
    if (!activationTokenMatches) {
      this.deps.logger.warn('Preview URL activation token mismatch', {
        port,
        runtimeIdentityID: availability.runtime.id
      });
      return {
        status: 'stale',
        reason: 'token-mismatch',
        containerStatus: snapshot.containerStatus
      };
    }

    return { status: 'active', runtime: availability.runtime };
  }

  private async getCurrentPreviewPorts(): Promise<CurrentPreviewPort[]> {
    const snapshot = await this.readRuntimeSnapshot();
    const availability = this.getRuntimeAvailability(snapshot);
    if (availability.status === 'stale') {
      return [];
    }

    const activePorts: CurrentPreviewPort[] = [];

    for (const [portKey, activation] of Object.entries(snapshot.activations)) {
      const port = Number.parseInt(portKey, 10);
      const entry = snapshot.tokens[portKey];
      if (!entry || !Number.isInteger(port) || !validatePort(port)) {
        continue;
      }

      if (!availability.runtime.owns(activation)) {
        continue;
      }

      if (!previewTokensMatch(entry.token, activation.token)) {
        continue;
      }

      activePorts.push({ port, entry });
    }

    return activePorts.sort((a, b) => a.port - b.port);
  }

  private async readRuntimeSnapshot(): Promise<PreviewRuntimeSnapshot> {
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

    return {
      containerStatus: containerState.status,
      containerRunning,
      tokens,
      activations,
      runtime
    };
  }

  private getRuntimeAvailability(
    snapshot: PreviewRuntimeSnapshot
  ): PreviewRuntimeAvailability {
    if (snapshot.containerStatus !== 'healthy') {
      return {
        status: 'stale',
        reason: 'runtime-not-healthy',
        containerStatus: snapshot.containerStatus
      };
    }

    if (!snapshot.containerRunning) {
      return {
        status: 'stale',
        reason: 'runtime-not-running',
        containerStatus: snapshot.containerStatus
      };
    }

    if (!snapshot.runtime) {
      return {
        status: 'stale',
        reason: 'missing-runtime-id',
        containerStatus: snapshot.containerStatus
      };
    }

    return { status: 'active', runtime: snapshot.runtime };
  }
}
