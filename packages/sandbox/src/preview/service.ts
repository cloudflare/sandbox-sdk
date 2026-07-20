import { type Logger, logCanonicalEvent } from '@repo/shared';
import type { ErrorResponse } from '../errors';
import {
  CustomDomainRequiredError,
  ErrorCode,
  OperationInterruptedError,
  RuntimeControlProtocolError
} from '../errors';
import type { RuntimeLease } from '../runtime';
import type { RuntimeIdentity } from '../runtime/types';
import { RuntimeIdentityInactiveError } from '../runtime/types';
import { SandboxSecurityError, validatePort } from '../security';
import {
  forwardPreviewRequest,
  type PreviewForwardingLease,
  type PreviewTCPPort
} from './forwarding';
import { readPreviewProxyMetadata } from './protocol';
import { buildPreviewProxyRequest } from './proxy-request';
import { constructPreviewURL } from './route';
import {
  type CurrentPreviewPort,
  clearActivePreviewPorts,
  PORT_TOKENS_STORAGE_KEY,
  type PortTokenEntry,
  type PreviewPortActivation,
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
  | { status: 'active'; activation: PreviewPortActivation };

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

type PreviewExposureLease = Pick<RuntimeLease, 'runtime' | 'retain'>;

type PreviewExposureCommit = {
  portKey: string;
  previousEntry: PortTokenEntry | undefined;
  previousActivation: PreviewPortActivation | undefined;
  entry: PortTokenEntry;
  activation: PreviewPortActivation;
};

export interface PreviewServiceDeps {
  storage: DurableObjectStorage;
  logger: Logger;
  getStoredRuntime(
    storage: DurableObjectTransaction
  ): Promise<RuntimeIdentity | null>;
  assertRuntimeActive(runtime: RuntimeIdentity): Promise<void>;
  getContainerState(): Promise<{ status: string }>;
  getForwardingContainer(): PreviewForwardingContainer | undefined;
  runWaking<T>(
    operation: string,
    call: (lease: PreviewExposureLease) => Promise<T>
  ): Promise<T>;
  runExisting<T>(
    operation: string,
    call: (
      lease: PreviewForwardingLease & { runtime: RuntimeIdentity }
    ) => Promise<T>
  ): Promise<T | null>;
  getSandboxName(): string | null;
  getNormalizeID(): boolean;
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
    let committed: PreviewExposureCommit | undefined;
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

      await this.preflightTokenCollision(port, options.token);

      const result = await this.deps.runWaking(
        'preview.expose',
        async (lease) => {
          let interrupted = false;
          const hold = lease.retain(() => {
            interrupted = true;
          });
          const assertLeaseActive = () => {
            if (interrupted) throw new RuntimeIdentityInactiveError();
          };
          const runtime = lease.runtime;
          try {
            assertLeaseActive();
            await this.deps.assertRuntimeActive(runtime);

            const exposure = await this.deps.storage.transaction(
              async (txn) => {
                const portKey = port.toString();
                const tokens = await readPortTokens(txn);
                const previousEntry = tokens[portKey];
                const nextToken =
                  options.token ??
                  previousEntry?.token ??
                  generatePreviewToken();

                const existingPort = Object.entries(tokens).find(
                  ([p, entry]) => entry.token === nextToken && p !== portKey
                );
                if (existingPort) {
                  throw new SandboxSecurityError(
                    `Token '${nextToken}' is already in use by port ${existingPort[0]}. Please use a different token.`
                  );
                }

                const activations = await readActivePreviewPorts(txn);
                const previousActivation = activations[portKey];
                const storedRuntime = await this.deps.getStoredRuntime(txn);
                assertLeaseActive();
                if (!storedRuntime || !sameRuntime(storedRuntime, runtime)) {
                  throw new RuntimeIdentityInactiveError();
                }

                const entry = { token: nextToken, name: options.name };
                const activation = {
                  runtimeIdentityID: runtime.id,
                  runtimeIncarnationID: runtime.runtimeIncarnationID,
                  token: nextToken
                };
                tokens[portKey] = entry;
                activations[portKey] = activation;
                await Promise.all([
                  txn.put(PORT_TOKENS_STORAGE_KEY, tokens),
                  writeActivePreviewPorts(activations, txn)
                ]);

                return {
                  token: nextToken,
                  commit: {
                    portKey,
                    previousEntry,
                    previousActivation,
                    entry,
                    activation
                  }
                };
              }
            );
            committed = exposure.commit;

            assertLeaseActive();
            await this.deps.assertRuntimeActive(runtime);
            assertLeaseActive();
            const token = exposure.token;

            const url = constructPreviewURL({
              port,
              sandboxId: sandboxName,
              effectiveId: sandboxName,
              hostname: options.hostname,
              token,
              normalizeId: this.deps.getNormalizeID()
            });

            return {
              url,
              port,
              name: options.name
            };
          } finally {
            hold.release();
          }
        }
      );

      outcome = 'success';

      return result;
    } catch (error) {
      if (committed) await this.rollbackExposureIfUnchanged(committed);
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

  private async rollbackExposureIfUnchanged(
    commit: PreviewExposureCommit
  ): Promise<void> {
    await this.deps.storage.transaction(async (txn) => {
      const [tokens, activations] = await Promise.all([
        readPortTokens(txn),
        readActivePreviewPorts(txn)
      ]);
      if (
        !samePortTokenEntry(tokens[commit.portKey], commit.entry) ||
        !isSameActivation(activations[commit.portKey], commit.activation)
      ) {
        return;
      }

      if (commit.previousEntry) tokens[commit.portKey] = commit.previousEntry;
      else delete tokens[commit.portKey];
      if (commit.previousActivation) {
        activations[commit.portKey] = commit.previousActivation;
      } else {
        delete activations[commit.portKey];
      }
      await Promise.all([
        txn.put(PORT_TOKENS_STORAGE_KEY, tokens),
        writeActivePreviewPorts(activations, txn)
      ]);
    });
  }

  private async preflightTokenCollision(
    port: number,
    requestedToken: string | undefined
  ): Promise<void> {
    const tokens = await readPortTokens(this.deps.storage);
    const existingEntry = tokens[port.toString()];
    const candidate = requestedToken ?? existingEntry?.token;
    if (!candidate) return;
    const existingPort = Object.entries(tokens).find(
      ([p, entry]) => entry.token === candidate && p !== port.toString()
    );
    if (existingPort) {
      throw new SandboxSecurityError(
        `Token '${candidate}' is already in use by port ${existingPort[0]}. Please use a different token.`
      );
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

    try {
      const response = await this.deps.runExisting(
        'preview.forward',
        async (lease) =>
          await this.fetchPreviewIfRunning(
            proxyRequest,
            port,
            validation.activation,
            lease
          )
      );

      if (response) return response;
      await this.clearActivationIfUnchanged(port, validation.activation);
      return this.stalePreviewURLResponse();
    } catch (error) {
      if (
        error instanceof OperationInterruptedError ||
        isActivationMismatch(error)
      ) {
        await this.clearActivationIfUnchanged(port, validation.activation);
        return this.stalePreviewURLResponse();
      }
      throw error;
    }
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
    activation: PreviewPortActivation,
    lease: PreviewForwardingLease & { runtime: RuntimeIdentity }
  ): Promise<Response> {
    if (!samePreviewRuntime(lease.runtime, activation)) {
      await this.clearActivationIfUnchanged(port, activation);
      return this.stalePreviewURLResponse();
    }

    const container = this.deps.getForwardingContainer();
    if (!container?.running) {
      return this.stalePreviewURLResponse();
    }

    const tcpPort = container.getTcpPort(port);

    const result = await forwardPreviewRequest(tcpPort, request, lease);

    if (result.status === 'network-lost') {
      return this.stalePreviewURLResponse();
    }

    return result.response;
  }

  private async validatePreviewURLForRuntime(
    port: number,
    token: string
  ): Promise<PreviewURLRuntimeValidation> {
    const { tokens, activations } = await this.deps.storage.transaction(
      async (txn) => readPreviewState(txn)
    );
    const entry = tokens[port.toString()];
    if (!entry) {
      return { status: 'invalid' };
    }

    const tokenMatches = previewTokensMatch(entry.token, token);
    if (!tokenMatches) {
      return { status: 'invalid' };
    }

    const activation = activations[port.toString()];
    if (!isPreviewActivation(activation)) {
      if (activation) await this.clearActivationIfUnchanged(port, activation);
      return {
        status: 'stale',
        reason: 'missing-activation'
      };
    }

    const activationTokenMatches = previewTokensMatch(activation.token, token);
    if (!activationTokenMatches) {
      this.deps.logger.warn('Preview URL activation token mismatch', {
        port,
        runtimeIdentityID: activation.runtimeIdentityID
      });
      await this.clearActivationIfUnchanged(port, activation);
      return {
        status: 'stale',
        reason: 'token-mismatch'
      };
    }

    return { status: 'active', activation };
  }

  private async clearActivationIfUnchanged(
    port: number,
    expected: PreviewPortActivation
  ): Promise<void> {
    await this.deps.storage.transaction(async (txn) => {
      const activations = await readActivePreviewPorts(txn);
      const current = activations[port.toString()];
      if (!isSameActivation(current, expected)) return;
      delete activations[port.toString()];
      await writeActivePreviewPorts(activations, txn);
    });
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

      if (
        !isPreviewActivation(activation) ||
        !samePreviewRuntime(availability.runtime, activation)
      ) {
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
          this.deps.getStoredRuntime(txn)
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

function sameRuntime(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return (
    left.id === right.id &&
    left.runtimeIncarnationID === right.runtimeIncarnationID
  );
}

function samePreviewRuntime(
  runtime: RuntimeIdentity,
  activation: PreviewPortActivation
): boolean {
  return (
    runtime.id === activation.runtimeIdentityID &&
    runtime.runtimeIncarnationID === activation.runtimeIncarnationID
  );
}

function samePortTokenEntry(
  left: PortTokenEntry | undefined,
  right: PortTokenEntry
): boolean {
  return Boolean(
    left && left.token === right.token && left.name === right.name
  );
}

function isPreviewActivation(value: unknown): value is PreviewPortActivation {
  if (!value || typeof value !== 'object') return false;
  const activation = value as Partial<
    Record<keyof PreviewPortActivation, unknown>
  >;
  return (
    typeof activation.runtimeIdentityID === 'string' &&
    activation.runtimeIdentityID.length > 0 &&
    typeof activation.runtimeIncarnationID === 'string' &&
    activation.runtimeIncarnationID.length > 0 &&
    typeof activation.token === 'string'
  );
}

function isSameActivation(
  left: PreviewPortActivation | undefined,
  right: PreviewPortActivation
): boolean {
  return Boolean(
    left &&
    left.runtimeIdentityID === right.runtimeIdentityID &&
    left.runtimeIncarnationID === right.runtimeIncarnationID &&
    left.token === right.token
  );
}

function isActivationMismatch(error: unknown): boolean {
  return (
    error instanceof RuntimeControlProtocolError &&
    error.context.reason === 'activation-mismatch'
  );
}
