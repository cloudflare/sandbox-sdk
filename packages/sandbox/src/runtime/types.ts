import type { RuntimeMetadata } from '@repo/shared';
import type { ContainerControlClient } from '../container-control/client';
import type {
  RuntimeIdentityID,
  RuntimeScoped
} from '../current-runtime-identity';

export type RuntimeIncarnationID = string & {
  readonly __runtimeIncarnationID: unique symbol;
};

export class RuntimeIdentity {
  readonly id: RuntimeIdentityID;
  readonly runtimeIncarnationID: RuntimeIncarnationID;

  constructor(record: {
    readonly id: RuntimeIdentityID;
    readonly runtimeIncarnationID: RuntimeIncarnationID;
  }) {
    this.id = record.id;
    this.runtimeIncarnationID = record.runtimeIncarnationID;
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

export type RuntimeRecord = {
  readonly schemaVersion: 1;
  readonly id: RuntimeIdentityID;
  readonly runtimeIncarnationID: RuntimeIncarnationID;
};

export type RuntimeRecordStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
};

export interface RuntimeIdentityReader {
  get(): Promise<RuntimeIdentity | null>;
  getStored(storage?: RuntimeRecordStorage): Promise<RuntimeIdentity | null>;
  isActive(runtime: RuntimeIdentity): Promise<boolean>;
  assertActive(runtime: RuntimeIdentity): Promise<void>;
}

export interface RuntimeBootstrapProbe {
  probe(): Promise<RuntimeMetadata>;
}

export type RuntimeConnectionHold = {
  release(): void;
};

export type RuntimeSession = {
  readonly client: ContainerControlClient;
  readonly interrupted: Promise<never>;
  isInterrupted(): boolean;
  retain(onInterrupt?: () => void): RuntimeConnectionHold;
};

export interface RuntimeSessionManager {
  acquire(runtime: RuntimeIdentity): Promise<ContainerControlClient>;
  acquireSession(runtime: RuntimeIdentity): Promise<RuntimeSession>;
  closeActive(): void;
  dispose(): void;
}
