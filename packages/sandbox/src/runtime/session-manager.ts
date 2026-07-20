import type { Logger, SandboxControlCallback } from '@repo/shared';
import type { RpcTarget } from 'capnweb';
import { ContainerControlClient } from '../container-control/client';
import {
  ContainerControlConnection,
  type ContainerFetchStub
} from '../container-control/connection';
import { translateRPCError } from '../container-control/rpc-error';
import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import { RuntimeControlProtocolError } from '../errors';
import { validateRuntimeMetadata } from './bootstrap-probe';
import { interrupted } from './operation-runner';
import type {
  RuntimeConnectionHold,
  RuntimeIdentity,
  RuntimeSession,
  RuntimeSessionManager as RuntimeSessionManagerContract
} from './types';

export type RuntimeControlCallbackBinder = (
  runtime: RuntimeIdentity,
  isSessionCurrent: () => boolean
) => (SandboxControlCallback & RpcTarget) | undefined;

export type RuntimeSessionManagerOptions = {
  getTcpPort: (port: number) => ContainerFetchStub;
  logger?: Logger;
  callbackBinder?: RuntimeControlCallbackBinder;
  onConnectionClose?: () => void;
};

type CachedSession = RuntimeSession & {
  generation: number;
  key: string;
  connection: ContainerControlConnection;
  client: ContainerControlClient;
  holds: Set<ManagedRuntimeConnectionHold>;
  interrupt(operation: string): void;
};

type OpeningSession = {
  key: string;
  generation: number;
  connection: ContainerControlConnection;
  promise: Promise<CachedSession>;
};

export class RuntimeSessionManager implements RuntimeSessionManagerContract {
  private cached: CachedSession | null = null;
  private opening: OpeningSession | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: RuntimeSessionManagerOptions) {}

  async acquire(runtime: RuntimeIdentity): Promise<ContainerControlClient> {
    return (await this.acquireSession(runtime)).client;
  }

  async acquireSession(runtime: RuntimeIdentity): Promise<RuntimeSession> {
    const key = this.cacheKey(runtime);
    if (this.disposed) throw new Error('Runtime session manager is disposed');
    if (this.cached?.key === key) return this.cached;
    if (this.opening?.key === key) return await this.opening.promise;

    this.supersedeCurrentSession();
    const generation = ++this.generation;
    const connection = this.createConnection(runtime, generation);
    const promise = this.open(runtime, key, generation, connection);
    this.opening = { key, generation, connection, promise };

    try {
      return await promise;
    } finally {
      if (this.opening?.promise === promise) this.opening = null;
    }
  }

  closeActive(): void {
    this.generation += 1;
    this.opening?.connection.disconnect();
    this.opening = null;
    const cached = this.cached;
    this.cached = null;
    this.interruptSession(cached, 'runtime.session.closeActive');
    cached?.connection.disconnect();
  }

  dispose(): void {
    this.disposed = true;
    this.closeActive();
  }

  private supersedeCurrentSession(): void {
    this.opening?.connection.disconnect();
    this.opening = null;
    const previous = this.cached;
    this.cached = null;
    this.interruptSession(previous, 'runtime.session.superseded');
    previous?.connection.disconnect();
  }

  private retainSession(
    session: CachedSession,
    onInterrupt?: () => void
  ): RuntimeConnectionHold {
    if (session.isInterrupted()) {
      onInterrupt?.();
      return { release: () => {} };
    }
    const hold = new ManagedRuntimeConnectionHold(onInterrupt, () => {
      session.holds.delete(hold);
    });
    session.holds.add(hold);
    if (session.isInterrupted()) hold.forceRelease();
    return hold;
  }

  private interruptSession(
    session: CachedSession | null,
    operation: string
  ): void {
    if (!session) return;
    session.interrupt(operation);
    for (const hold of [...session.holds]) hold.forceRelease();
  }

  private createConnection(
    runtime: RuntimeIdentity,
    generation: number
  ): ContainerControlConnection {
    let connection: ContainerControlConnection;
    connection = new ContainerControlConnection({
      stub: this.options.getTcpPort(3000),
      retryTimeoutMs: 0,
      logger: this.options.logger,
      localMain: this.bindLocalMain(runtime, generation),
      onClose: () => {
        const cached =
          this.cached?.connection === connection ? this.cached : null;
        if (cached) this.cached = null;
        this.interruptSession(cached, 'runtime.session.transportClosed');
        this.options.onConnectionClose?.();
      }
    });
    return connection;
  }

  private async open(
    runtime: RuntimeIdentity,
    key: string,
    generation: number,
    connection: ContainerControlConnection
  ): Promise<CachedSession> {
    try {
      const metadata = validateRuntimeMetadata(
        await this.activate(connection, runtime),
        'utils.activateControlSession'
      );
      if (metadata.runtimeIncarnationID !== runtime.runtimeIncarnationID) {
        throw this.activationMismatch();
      }
      this.assertCurrentOpening(generation, connection);

      const client = new ContainerControlClient({
        stub: this.options.getTcpPort(3000),
        retryTimeoutMs: 0,
        logger: this.options.logger,
        translateTransportErrorsAsInterruptions: false,
        connection,
        externallyOwnedConnection: true,
        onConnectionClose: () => {
          const cached =
            this.cached?.connection === connection ? this.cached : null;
          if (cached) this.cached = null;
          this.interruptSession(cached, 'runtime.session.transportClosed');
          this.options.onConnectionClose?.();
        }
      });
      let rejectInterrupted!: (error: Error) => void;
      let poisoned = false;
      const session: CachedSession = {
        generation,
        key,
        connection,
        client,
        holds: new Set(),
        interrupted: new Promise<never>((_, reject) => {
          rejectInterrupted = reject;
        }),
        isInterrupted: () => poisoned,
        interrupt: (operation) => {
          if (poisoned) return;
          poisoned = true;
          rejectInterrupted(interrupted(operation));
        },
        retain: (onInterrupt) => this.retainSession(session, onInterrupt)
      };
      session.interrupted.catch(() => undefined);
      this.assertCurrentOpening(generation, connection);
      this.cached = session;
      return session;
    } catch (error) {
      connection.disconnect();
      throw error;
    }
  }

  private assertCurrentOpening(
    generation: number,
    connection: ContainerControlConnection
  ): void {
    if (
      this.disposed ||
      generation !== this.generation ||
      this.opening?.connection !== connection
    ) {
      connection.disconnect();
      throw new RuntimeIdentityInactiveError();
    }
  }

  private async activate(
    connection: ContainerControlConnection,
    runtime: RuntimeIdentity
  ) {
    try {
      return await connection.activateControlSession(
        runtime.runtimeIncarnationID
      );
    } catch (error) {
      if (this.isActivationMismatchError(error))
        throw this.activationMismatch(error);
      translateRPCError(error, {
        operation: 'utils.activateControlSession',
        translateTransportErrorsAsInterruptions: false
      });
    }
  }

  private isActivationMismatchError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: unknown }).code;
    return (
      code === 'CONTROL_PROTOCOL_INCOMPATIBLE' ||
      /runtime incarnation does not match|control protocol incompatible/i.test(
        error.message
      )
    );
  }

  private activationMismatch(cause?: unknown): RuntimeControlProtocolError {
    return new RuntimeControlProtocolError(
      'Activated runtime incarnation does not match expected runtime',
      {
        reason: 'activation-mismatch',
        operation: 'utils.activateControlSession'
      },
      { cause }
    );
  }

  private bindLocalMain(
    runtime: RuntimeIdentity,
    generation: number
  ): (SandboxControlCallback & RpcTarget) | undefined {
    return this.options.callbackBinder?.(runtime, () =>
      this.isSessionGenerationCurrent(generation)
    );
  }

  private isSessionGenerationCurrent(generation: number): boolean {
    if (this.disposed || this.generation !== generation) return false;
    return (
      this.cached?.generation === generation ||
      this.opening?.generation === generation
    );
  }

  private cacheKey(runtime: RuntimeIdentity): string {
    return `${runtime.id}\0${runtime.runtimeIncarnationID}`;
  }
}

class ManagedRuntimeConnectionHold implements RuntimeConnectionHold {
  private active = true;

  constructor(
    private readonly onInterrupt: (() => void) | undefined,
    private readonly onRelease: () => void
  ) {}

  release(): void {
    this.releaseInternal(false);
  }

  forceRelease(): void {
    this.releaseInternal(true);
  }

  private releaseInternal(interrupted: boolean): void {
    if (!this.active) return;
    this.active = false;
    this.onRelease();
    if (interrupted) this.onInterrupt?.();
  }
}
