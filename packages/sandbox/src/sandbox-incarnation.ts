export type SandboxIncarnationID = string & {
  readonly __sandboxIncarnationID: unique symbol;
};

export type SandboxIncarnationRecord = {
  id: SandboxIncarnationID;
  generation: number;
  createdAt: string;
  updatedAt: string;
};

type SandboxIncarnationStorage = Pick<
  DurableObjectStorage | DurableObjectTransaction,
  'get' | 'put'
>;

const SANDBOX_INCARNATION_STORAGE_KEY = 'sandbox:incarnation';

export class SandboxIncarnationChangedError extends Error {
  constructor() {
    super('Sandbox incarnation is no longer current');
    this.name = 'SandboxIncarnationChangedError';
  }
}

export class SandboxIncarnation {
  readonly id: SandboxIncarnationID;
  readonly generation: number;
  readonly createdAt: string;
  readonly updatedAt: string;

  constructor(readonly record: SandboxIncarnationRecord) {
    this.id = record.id;
    this.generation = record.generation;
    this.createdAt = record.createdAt;
    this.updatedAt = record.updatedAt;
  }

  owns(record: { readonly incarnationId: SandboxIncarnationID }): boolean {
    return record.incarnationId === this.id;
  }

  scope<T extends object>(
    value: T
  ): T & { incarnationId: SandboxIncarnationID } {
    return {
      ...value,
      incarnationId: this.id
    };
  }
}

export class CurrentSandboxIncarnation {
  constructor(private readonly storage: SandboxIncarnationStorage) {}

  async get(): Promise<SandboxIncarnation | null> {
    const record =
      (await this.storage.get<SandboxIncarnationRecord>(
        SANDBOX_INCARNATION_STORAGE_KEY
      )) ?? null;
    return record ? new SandboxIncarnation(record) : null;
  }

  async getOrCreate(): Promise<SandboxIncarnation> {
    const existing = await this.get();
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const record: SandboxIncarnationRecord = {
      id: crypto.randomUUID() as SandboxIncarnationID,
      generation: 1,
      createdAt: now,
      updatedAt: now
    };
    await this.storage.put(SANDBOX_INCARNATION_STORAGE_KEY, record);
    return new SandboxIncarnation(record);
  }

  async rotate(): Promise<SandboxIncarnation> {
    const existing = await this.get();
    const now = new Date().toISOString();
    const record: SandboxIncarnationRecord = {
      id: crypto.randomUUID() as SandboxIncarnationID,
      generation: (existing?.generation ?? 0) + 1,
      createdAt: now,
      updatedAt: now
    };
    await this.storage.put(SANDBOX_INCARNATION_STORAGE_KEY, record);
    return new SandboxIncarnation(record);
  }

  async isCurrent(incarnation: SandboxIncarnation): Promise<boolean> {
    const current = await this.get();
    return current?.id === incarnation.id;
  }

  async assertCurrent(incarnation: SandboxIncarnation): Promise<void> {
    if (!(await this.isCurrent(incarnation))) {
      throw new SandboxIncarnationChangedError();
    }
  }
}
