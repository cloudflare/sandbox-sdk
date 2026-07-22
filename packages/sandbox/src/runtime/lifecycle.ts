import type { ContainerStartConfigOptions } from '@cloudflare/containers';
import type { ContainerControlClient } from '../container-control/client';
import {
  type RuntimeIdentityID,
  RuntimeIdentityInactiveError
} from '../runtime/types';
import { validateRuntimeMetadata } from './bootstrap-probe';
import type { RuntimeBootstrapProbe, RuntimeSessionManager } from './types';
import {
  RuntimeIdentity,
  type RuntimeIdentityReader,
  type RuntimeIncarnationID,
  type RuntimeRecord,
  type RuntimeRecordStorage
} from './types';

const RUNTIME_RECORD_KEY = 'currentRuntimeIdentity';

type LifecycleStorage = RuntimeRecordStorage &
  Pick<DurableObjectStorage, 'put' | 'delete'>;

type ReplacementStartTransition = {
  phase: 'reconciling-previous-stop' | 'replacement-started';
};

type RuntimeStopDisposition = 'reconciled-previous-stop' | 'hard-invalidation';

export type RuntimeEstablishOptions = {
  signal?: AbortSignal;
  startOptions?: ContainerStartConfigOptions;
};

export type SandboxRuntimeLifecycleOptions = {
  readonly storage: LifecycleStorage;
  readonly isRuntimeRunning: () => boolean;
  readonly startControlPort: (
    port: 3000,
    options?: RuntimeEstablishOptions
  ) => Promise<void>;
  readonly waitForControlPort: (
    port: 3000,
    options?: { signal?: AbortSignal }
  ) => Promise<void>;
  readonly stopControlPort?: (port: 3000) => Promise<void>;
  readonly probe: RuntimeBootstrapProbe;
  readonly sessions: RuntimeSessionManager;
  readonly observeVersionCompatibility: (
    client: ContainerControlClient,
    runtime: RuntimeIdentity
  ) => Promise<void>;
  readonly reconcileReplacement: (runtime: RuntimeIdentity) => Promise<void>;
};

export class SandboxRuntimeLifecycle implements RuntimeIdentityReader {
  private readonly changeListeners = new Set<() => void>();
  private generation = 0;
  private establishing: Promise<RuntimeIdentity> | null = null;
  private mutationGate: Promise<void> = Promise.resolve();
  private replacementStart: ReplacementStartTransition | null = null;

  constructor(private readonly options: SandboxRuntimeLifecycleOptions) {}

  get sessions(): RuntimeSessionManager {
    return this.options.sessions;
  }

  establish(options?: RuntimeEstablishOptions): Promise<RuntimeIdentity> {
    if (!this.establishing) {
      this.establishing = this.doEstablish(options).finally(() => {
        this.establishing = null;
      });
    }
    return this.establishing;
  }

  observeStoredActive(): Promise<RuntimeIdentity | null> {
    return this.getStored();
  }

  async get(): Promise<RuntimeIdentity | null> {
    if (!this.options.isRuntimeRunning()) return null;
    return this.getStored();
  }

  async getStored(
    storage: RuntimeRecordStorage = this.options.storage
  ): Promise<RuntimeIdentity | null> {
    const record = (await storage.get<unknown>(RUNTIME_RECORD_KEY)) ?? null;
    if (!isRuntimeRecord(record)) return null;
    return new RuntimeIdentity(record);
  }

  async isActive(runtime: RuntimeIdentity): Promise<boolean> {
    const active = await this.get();
    return (
      active?.id === runtime.id &&
      active.runtimeIncarnationID === runtime.runtimeIncarnationID
    );
  }

  async assertActive(runtime: RuntimeIdentity): Promise<void> {
    if (!(await this.isActive(runtime)))
      throw new RuntimeIdentityInactiveError();
  }

  async invalidate(expected?: RuntimeIdentity): Promise<void> {
    if (!expected) {
      await this.invalidateAndObserveStoredActive();
      return;
    }

    await this.withMutationGate(async () => {
      const stored = await this.getStored();
      if (!stored || !sameIdentity(stored, expected)) return;

      this.generation++;
      this.notifyChanged();
      this.options.sessions.closeActive();
      await this.options.storage.delete(RUNTIME_RECORD_KEY);
      await this.options.stopControlPort?.(3000);
    });
  }

  invalidateAndObserveStoredActive(): Promise<RuntimeIdentity | null> {
    return this.invalidateCurrent(true);
  }

  markRuntimeStarted(): boolean {
    if (this.replacementStart?.phase === 'reconciling-previous-stop') {
      this.replacementStart.phase = 'replacement-started';
      return true;
    }
    return false;
  }

  async reconcileObservedStop(): Promise<RuntimeStopDisposition> {
    const invalidateEstablishment =
      this.replacementStart?.phase !== 'reconciling-previous-stop';
    await this.invalidateCurrent(invalidateEstablishment);
    return invalidateEstablishment
      ? 'hard-invalidation'
      : 'reconciled-previous-stop';
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private async doEstablish(
    options?: RuntimeEstablishOptions
  ): Promise<RuntimeIdentity> {
    const needsPhysicalStart = !this.options.isRuntimeRunning();
    const replacementStart = needsPhysicalStart
      ? this.beginReplacementStart()
      : null;
    const generation = this.generation;

    try {
      const stored = await this.getStored();

      if (needsPhysicalStart) {
        await this.options.startControlPort(3000, options);
        if (replacementStart?.phase !== 'replacement-started') {
          throw new RuntimeIdentityInactiveError();
        }
        this.assertGeneration(generation);
        await this.options.waitForControlPort(3000, options);
        this.assertGeneration(generation);
      }

      const metadata = validateRuntimeMetadata(
        await this.options.probe.probe(),
        'runtime.lifecycle.probe'
      );
      this.assertGeneration(generation);

      const runtimeIncarnationID =
        metadata.runtimeIncarnationID as RuntimeIncarnationID;
      const runtime =
        stored?.runtimeIncarnationID === runtimeIncarnationID
          ? stored
          : new RuntimeIdentity({
              id: crypto.randomUUID() as RuntimeIdentityID,
              runtimeIncarnationID
            });
      const client = await this.options.sessions.acquire(runtime);
      this.assertGeneration(generation);
      await this.options.observeVersionCompatibility(client, runtime);
      this.assertGeneration(generation);

      if (!stored || !sameIdentity(stored, runtime)) {
        await this.options.reconcileReplacement(runtime);
        this.assertGeneration(generation);
      }

      if (!this.options.isRuntimeRunning())
        throw new RuntimeIdentityInactiveError();
      return await this.withMutationGate(async () => {
        this.assertGeneration(generation);
        await this.options.storage.put(RUNTIME_RECORD_KEY, toRecord(runtime));
        if (this.generation !== generation) {
          await this.deleteIfStored(runtime);
          throw new RuntimeIdentityInactiveError();
        }
        this.notifyChanged();
        return runtime;
      });
    } finally {
      this.endReplacementStart(replacementStart);
    }
  }

  private beginReplacementStart(): ReplacementStartTransition {
    const transition: ReplacementStartTransition = {
      phase: 'reconciling-previous-stop'
    };
    this.replacementStart = transition;
    return transition;
  }

  private endReplacementStart(
    transition: ReplacementStartTransition | null
  ): void {
    if (transition && this.replacementStart === transition) {
      this.replacementStart = null;
    }
  }

  private invalidateCurrent(
    invalidateEstablishment: boolean
  ): Promise<RuntimeIdentity | null> {
    if (invalidateEstablishment) this.generation++;
    this.notifyChanged();
    this.options.sessions.closeActive();
    return this.withMutationGate(async () => {
      const stored = await this.getStored();
      if (stored) await this.options.storage.delete(RUNTIME_RECORD_KEY);
      await this.options.stopControlPort?.(3000);
      return stored;
    });
  }

  private assertGeneration(generation: number): void {
    if (this.generation !== generation)
      throw new RuntimeIdentityInactiveError();
  }

  private async withMutationGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationGate;
    let release!: () => void;
    this.mutationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async deleteIfStored(runtime: RuntimeIdentity): Promise<void> {
    const stored = await this.getStored();
    if (stored && sameIdentity(stored, runtime)) {
      await this.options.storage.delete(RUNTIME_RECORD_KEY);
    }
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // Listener failures must not interrupt lifecycle state transitions.
      }
    }
  }
}

function toRecord(runtime: RuntimeIdentity): RuntimeRecord {
  return {
    schemaVersion: 1,
    id: runtime.id,
    runtimeIncarnationID: runtime.runtimeIncarnationID
  };
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return (
    left.id === right.id &&
    left.runtimeIncarnationID === right.runtimeIncarnationID
  );
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<RuntimeRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.runtimeIncarnationID === 'string' &&
    record.runtimeIncarnationID.length > 0
  );
}
