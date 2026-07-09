export type RuntimeIdentityID = string & {
  readonly __runtimeIdentityID: unique symbol;
};

export type RuntimeIdentityRecord = {
  id: RuntimeIdentityID;
};

export type RuntimeScoped<T extends object> = T & {
  readonly runtimeIdentityID: RuntimeIdentityID;
};

export type CurrentRuntimeStatus =
  | { status: 'active'; runtime: RuntimeIdentity; containerStatus: string }
  | {
      status: 'inactive';
      reason:
        | 'runtime-not-healthy'
        | 'runtime-not-running'
        | 'missing-runtime-id';
      containerStatus?: string;
    };

type RuntimeIdentityStorage = Pick<
  DurableObjectStorage | DurableObjectTransaction,
  'get'
>;

const CURRENT_RUNTIME_IDENTITY_STORAGE_KEY = 'currentRuntimeIdentity';

export class RuntimeIdentityInactiveError extends Error {
  constructor() {
    super('Runtime identity is no longer active');
    this.name = 'RuntimeIdentityInactiveError';
  }
}

export class RuntimeIdentity {
  readonly id: RuntimeIdentityID;

  constructor(record: RuntimeIdentityRecord) {
    this.id = record.id;
  }

  owns(record: { readonly runtimeIdentityID: RuntimeIdentityID }): boolean {
    return record.runtimeIdentityID === this.id;
  }

  scope<T extends object>(value: T): RuntimeScoped<T> {
    return {
      ...value,
      runtimeIdentityID: this.id
    };
  }
}

export class CurrentRuntimeIdentity {
  private readonly changeListeners = new Set<() => void>();
  private transitionEpoch = 0;
  private pendingTransitions = 0;
  private mutationRunning = false;
  private readonly mutationQueue: Array<() => void> = [];

  /**
   * Runtime identity is stored in Durable Object storage so a reconstructed DO
   * can still recognize the live container runtime it owns. In-memory state is
   * only a cache and cannot define runtime-scoped correctness.
   */
  constructor(
    private readonly storage: DurableObjectState['storage'],
    private readonly getContainerState: () => Promise<{ status: string }>,
    private readonly isContainerRunning: () => boolean
  ) {}

  async get(): Promise<RuntimeIdentity | null> {
    const status = await this.getStatus();
    return status.status === 'active' ? status.runtime : null;
  }

  async getStatus(): Promise<CurrentRuntimeStatus> {
    const epoch = this.transitionEpoch;
    if (!this.isCurrentEpoch(epoch)) {
      return { status: 'inactive', reason: 'missing-runtime-id' };
    }

    const state = await this.getContainerState();
    if (!this.isCurrentEpoch(epoch)) {
      return { status: 'inactive', reason: 'missing-runtime-id' };
    }
    if (state.status !== 'healthy') {
      return {
        status: 'inactive',
        reason: 'runtime-not-healthy',
        containerStatus: state.status
      };
    }

    if (!this.isContainerRunning()) {
      return {
        status: 'inactive',
        reason: 'runtime-not-running',
        containerStatus: state.status
      };
    }

    const runtime = await this.getStored();
    if (!this.isCurrentEpoch(epoch)) {
      return { status: 'inactive', reason: 'missing-runtime-id' };
    }
    if (!runtime) {
      return {
        status: 'inactive',
        reason: 'missing-runtime-id',
        containerStatus: state.status
      };
    }

    return {
      status: 'active',
      runtime,
      containerStatus: state.status
    };
  }

  async getStored(
    storage: RuntimeIdentityStorage = this.storage
  ): Promise<RuntimeIdentity | null> {
    const epoch = this.transitionEpoch;
    if (!this.isCurrentEpoch(epoch)) return null;

    const record =
      (await storage.get<RuntimeIdentityRecord>(
        CURRENT_RUNTIME_IDENTITY_STORAGE_KEY
      )) ?? null;
    if (!this.isCurrentEpoch(epoch)) return null;
    return record ? new RuntimeIdentity(record) : null;
  }

  markStarted(): Promise<RuntimeIdentity> {
    const record: RuntimeIdentityRecord = {
      id: crypto.randomUUID() as RuntimeIdentityID
    };
    return this.enqueueMutation(async () => {
      await this.storage.put(CURRENT_RUNTIME_IDENTITY_STORAGE_KEY, record);
      return new RuntimeIdentity(record);
    });
  }

  clear(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.storage.delete(CURRENT_RUNTIME_IDENTITY_STORAGE_KEY);
    });
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) listener();
  }

  private isCurrentEpoch(epoch: number): boolean {
    return this.pendingTransitions === 0 && this.transitionEpoch === epoch;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.transitionEpoch++;
    this.pendingTransitions++;
    try {
      this.notifyChanged();
    } catch (error) {
      this.pendingTransitions--;
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.mutationRunning = true;
        let result: Promise<T>;
        try {
          result = operation();
        } catch (error) {
          this.completeMutation();
          reject(error);
          return;
        }
        result.then(
          (value) => {
            this.completeMutation();
            resolve(value);
          },
          (error: unknown) => {
            this.completeMutation();
            reject(error);
          }
        );
      };

      if (this.mutationRunning) {
        this.mutationQueue.push(run);
      } else {
        run();
      }
    });
  }

  private completeMutation(): void {
    this.pendingTransitions--;
    this.mutationRunning = false;
    this.mutationQueue.shift()?.();
  }

  async isActive(runtime: RuntimeIdentity): Promise<boolean> {
    const current = await this.get();
    return current?.id === runtime.id;
  }

  async assertActive(runtime: RuntimeIdentity): Promise<void> {
    if (!(await this.isActive(runtime))) {
      throw new RuntimeIdentityInactiveError();
    }
  }
}
