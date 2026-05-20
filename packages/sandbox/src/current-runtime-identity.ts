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
    const state = await this.getContainerState();
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
    const record =
      (await storage.get<RuntimeIdentityRecord>(
        CURRENT_RUNTIME_IDENTITY_STORAGE_KEY
      )) ?? null;
    return record ? new RuntimeIdentity(record) : null;
  }

  async markStarted(): Promise<RuntimeIdentity> {
    const record: RuntimeIdentityRecord = {
      id: crypto.randomUUID() as RuntimeIdentityID
    };
    await this.storage.put(CURRENT_RUNTIME_IDENTITY_STORAGE_KEY, record);
    return new RuntimeIdentity(record);
  }

  async clear(): Promise<void> {
    await this.storage.delete(CURRENT_RUNTIME_IDENTITY_STORAGE_KEY);
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
