export type SandboxLifetimeID = string & {
  readonly __sandboxLifetimeID: unique symbol;
};

export type SandboxLifetimeRecord = {
  id: SandboxLifetimeID;
  generation: number;
  createdAt: string;
  updatedAt: string;
};

type SandboxLifetimeStorage = Pick<
  DurableObjectStorage | DurableObjectTransaction,
  'get' | 'put'
>;

const SANDBOX_LIFETIME_STORAGE_KEY = 'sandbox:lifetime';

export class SandboxLifetimeChangedError extends Error {
  constructor() {
    super('Sandbox lifetime is no longer current');
    this.name = 'SandboxLifetimeChangedError';
  }
}

export class SandboxLifetime {
  readonly id: SandboxLifetimeID;
  readonly generation: number;
  readonly createdAt: string;
  readonly updatedAt: string;

  constructor(readonly record: SandboxLifetimeRecord) {
    this.id = record.id;
    this.generation = record.generation;
    this.createdAt = record.createdAt;
    this.updatedAt = record.updatedAt;
  }

  owns(record: { readonly sandboxLifetimeID: SandboxLifetimeID }): boolean {
    return record.sandboxLifetimeID === this.id;
  }

  scope<T extends object>(
    value: T
  ): T & { sandboxLifetimeID: SandboxLifetimeID } {
    return {
      ...value,
      sandboxLifetimeID: this.id
    };
  }
}

export class CurrentSandboxLifetime {
  constructor(private readonly storage: SandboxLifetimeStorage) {}

  async get(): Promise<SandboxLifetime | null> {
    const record =
      (await this.storage.get<SandboxLifetimeRecord>(
        SANDBOX_LIFETIME_STORAGE_KEY
      )) ?? null;
    return record ? new SandboxLifetime(record) : null;
  }

  async getOrCreate(): Promise<SandboxLifetime> {
    const existing = await this.get();
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const record: SandboxLifetimeRecord = {
      id: crypto.randomUUID() as SandboxLifetimeID,
      generation: 1,
      createdAt: now,
      updatedAt: now
    };
    await this.storage.put(SANDBOX_LIFETIME_STORAGE_KEY, record);
    return new SandboxLifetime(record);
  }

  async rotate(): Promise<SandboxLifetime> {
    const existing = await this.get();
    const now = new Date().toISOString();
    const record: SandboxLifetimeRecord = {
      id: crypto.randomUUID() as SandboxLifetimeID,
      generation: (existing?.generation ?? 0) + 1,
      createdAt: now,
      updatedAt: now
    };
    await this.storage.put(SANDBOX_LIFETIME_STORAGE_KEY, record);
    return new SandboxLifetime(record);
  }

  async isCurrent(lifetime: SandboxLifetime): Promise<boolean> {
    const current = await this.get();
    return current?.id === lifetime.id;
  }

  async assertCurrent(lifetime: SandboxLifetime): Promise<void> {
    if (!(await this.isCurrent(lifetime))) {
      throw new SandboxLifetimeChangedError();
    }
  }
}
