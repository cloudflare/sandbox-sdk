import { ErrorCode } from '@repo/shared';
import { getHttpStatus } from '@repo/shared/errors';
import type { ContainerControlClient } from '../container-control/client';
import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import { OperationInterruptedError } from '../errors';
import type { ResourceActivityGate } from '../resource-activity-gate';
import type {
  RuntimeEstablishOptions,
  SandboxRuntimeLifecycle
} from './lifecycle';
import type {
  RuntimeConnectionHold,
  RuntimeIdentity,
  RuntimeSession
} from './types';

export type RuntimeAbsent = { status: 'absent' };
export const RUNTIME_ABSENT: RuntimeAbsent = { status: 'absent' };

export type RuntimeLease = {
  runtime: RuntimeIdentity;
  control: ContainerControlClient;
  retain(onInterrupt?: () => void): RuntimeConnectionHold;
};

export type RuntimeOperationTarget =
  | { kind: 'current' }
  | { kind: 'runtime'; runtime: RuntimeIdentity };

export type RuntimeOperationRunnerOptions = {
  lifecycle: SandboxRuntimeLifecycle;
  activityGate: ResourceActivityGate;
};

type ActivityAdmission = ReturnType<ResourceActivityGate['beginActivity']>;

export class RuntimeOperationRunner {
  constructor(private readonly options: RuntimeOperationRunnerOptions) {}

  async runWaking<T>(
    operation: string,
    call: (lease: RuntimeLease) => Promise<T>,
    establishOptions?: RuntimeEstablishOptions
  ): Promise<T> {
    const owner = new OperationActivityOwner(
      this.options.activityGate.beginActivity()
    );
    try {
      await owner.beforeCall;
      let runtime: RuntimeIdentity;
      try {
        runtime = await this.options.lifecycle.establish(establishOptions);
      } catch (error) {
        if (
          error instanceof RuntimeIdentityInactiveError ||
          error instanceof OperationInterruptedError
        ) {
          throw interrupted(operation);
        }
        throw error;
      }
      return await this.runWithLease(runtime, operation, owner, call);
    } finally {
      owner.releaseBase();
    }
  }

  async runExisting<T>(
    target: RuntimeOperationTarget,
    operation: string,
    call: (lease: RuntimeLease) => Promise<T>
  ): Promise<T | RuntimeAbsent> {
    const owner = new OperationActivityOwner(
      this.options.activityGate.beginExistingHold()
    );
    try {
      await owner.beforeCall;
      const runtime = await this.resolveExisting(target);
      if (!runtime) return RUNTIME_ABSENT;
      return await this.runWithLease(runtime, operation, owner, call);
    } finally {
      owner.releaseBase();
    }
  }

  async probeExisting<T>(
    target: RuntimeOperationTarget,
    operation: string,
    call: (lease: RuntimeLease) => Promise<T>
  ): Promise<T | RuntimeAbsent> {
    const owner = new OperationActivityOwner(
      this.options.activityGate.beginProbe()
    );
    try {
      await owner.beforeCall;
      const runtime = await this.resolveExisting(target);
      if (!runtime) return RUNTIME_ABSENT;
      return await this.runWithLease(runtime, operation, owner, call);
    } finally {
      owner.releaseBase();
    }
  }

  private async resolveExisting(
    target: RuntimeOperationTarget
  ): Promise<RuntimeIdentity | null> {
    const current = await this.options.lifecycle.get();
    if (!current) return null;
    if (target.kind === 'current') return current;
    if (sameIdentity(current, target.runtime)) return target.runtime;
    return null;
  }

  private async runWithLease<T>(
    runtime: RuntimeIdentity,
    operation: string,
    owner: OperationActivityOwner,
    call: (lease: RuntimeLease) => Promise<T>
  ): Promise<T> {
    const session =
      await this.options.lifecycle.sessions.acquireSession(runtime);
    const sessionHold = session.retain();
    const releaseChangeListener = this.options.lifecycle.onChange(() => {
      owner.interruptRetainedHolds();
    });
    try {
      await this.assertActive(runtime, operation);
      if (session.isInterrupted()) throw interrupted(operation);
      const lease: RuntimeLease = {
        runtime,
        control: session.client,
        retain: (onInterrupt) => {
          if (!owner.canRetain() || session.isInterrupted()) {
            onInterrupt?.();
            return { release: () => {} };
          }
          const activityHold = owner.retain();
          const retainedSessionHold = session.retain(() => {
            activityHold.release();
            onInterrupt?.();
          });
          return {
            release: once(() => {
              retainedSessionHold.release();
              activityHold.release();
            })
          };
        }
      };
      const result = await this.raceSession(session, operation, call(lease));
      await this.assertActive(runtime, operation);
      if (session.isInterrupted()) throw interrupted(operation);
      return result;
    } catch (error) {
      if (await this.shouldTranslateInterruption(runtime, session, error)) {
        throw interrupted(operation);
      }
      throw error;
    } finally {
      releaseChangeListener();
      sessionHold.release();
    }
  }

  private async raceSession<T>(
    session: RuntimeSession,
    operation: string,
    promise: Promise<T>
  ): Promise<T> {
    try {
      return await Promise.race([promise, session.interrupted]);
    } catch (error) {
      if (session.isInterrupted()) throw interrupted(operation);
      throw error;
    }
  }

  private async shouldTranslateInterruption(
    runtime: RuntimeIdentity,
    session: RuntimeSession,
    error: unknown
  ): Promise<boolean> {
    if (error instanceof RuntimeIdentityInactiveError) return true;
    if (session.isInterrupted()) return true;
    return !(await this.options.lifecycle.isActive(runtime));
  }

  private async assertActive(
    runtime: RuntimeIdentity,
    operation: string
  ): Promise<void> {
    try {
      await this.options.lifecycle.assertActive(runtime);
    } catch {
      throw interrupted(operation);
    }
  }
}

class OperationActivityOwner {
  private references = 1;
  private finished = false;
  private readonly retained = new Set<{ release(): void }>();

  constructor(private readonly activity: ActivityAdmission) {}

  get beforeCall(): Promise<void> {
    return this.activity.beforeCall;
  }

  canRetain(): boolean {
    return !this.finished;
  }

  retain(): RuntimeConnectionHold {
    if (!this.canRetain()) return { release: () => {} };
    this.references += 1;
    const hold = { release: once(() => this.releaseRetained(hold)) };
    this.retained.add(hold);
    return hold;
  }

  releaseBase(): void {
    this.releaseReference();
  }

  interruptRetainedHolds(): void {
    for (const hold of [...this.retained]) hold.release();
  }

  private releaseRetained(hold: { release(): void }): void {
    this.retained.delete(hold);
    this.releaseReference();
  }

  private releaseReference(): void {
    if (this.finished) return;
    this.references -= 1;
    if (this.references === 0) {
      this.finished = true;
      this.activity.finish();
    }
  }
}

export function interrupted(operation: string): OperationInterruptedError {
  return new OperationInterruptedError({
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: `Sandbox operation ${operation} was interrupted because the runtime changed`,
    context: {
      reason: 'runtime_replaced',
      operation,
      admitted: true,
      retryable: false
    },
    httpStatus: getHttpStatus(ErrorCode.OPERATION_INTERRUPTED),
    timestamp: new Date().toISOString()
  });
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return (
    left.id === right.id &&
    left.runtimeIncarnationID === right.runtimeIncarnationID
  );
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
