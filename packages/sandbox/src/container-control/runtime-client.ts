import type { Logger, SandboxControlCallback } from '@repo/shared';
import type { RpcTarget } from 'capnweb';
import type { RuntimeIdentityID } from '../current-runtime-identity';
import type { ResourceActivityOperation } from '../resource-activity-gate';
import {
  ContainerControlClient,
  type ContainerControlClientOptions
} from './client';
import type { ContainerFetchStub } from './connection';
import { translateRPCError } from './rpc-error';

type RuntimeControlClientOptions = {
  getTcpPort: (port: number) => ContainerFetchStub;
  beginNonWakingOperation: () => ResourceActivityOperation;
  logger?: Logger;
  localMain?: SandboxControlCallback & RpcTarget;
};

type RuntimeClientLease = {
  active: boolean;
};

type CachedRuntimeClient = {
  runtimeIdentityID: RuntimeIdentityID;
  client: ContainerControlClient;
  lease: RuntimeClientLease;
};

/** Owns at most one direct, non-starting control connection for one runtime. */
export class RuntimeControlClient {
  private cached: CachedRuntimeClient | null = null;

  constructor(private readonly options: RuntimeControlClientOptions) {}

  get(runtimeIdentityID: RuntimeIdentityID): ContainerControlClient {
    if (this.cached?.runtimeIdentityID === runtimeIdentityID) {
      return this.cached.client;
    }

    this.dispose();
    const lease: RuntimeClientLease = { active: true };
    let stub: ContainerFetchStub;
    try {
      stub = this.options.getTcpPort(3000);
    } catch (error) {
      translateRPCError(error);
    }
    const clientOptions: ContainerControlClientOptions = {
      stub,
      retryTimeoutMs: 0,
      logger: this.options.logger,
      localMain: this.options.localMain,
      onOperationStarted: this.options.beginNonWakingOperation,
      translateTransportErrorsAsInterruptions: false,
      onDispatch: () => {
        if (!lease.active) {
          throw new Error(
            'RPC session was shut down by disposing the main stub'
          );
        }
      }
    };
    const client = new ContainerControlClient({
      ...clientOptions,
      onConnectionClose: () => {
        lease.active = false;
        if (this.cached?.client === client) {
          this.cached = null;
        }
      }
    });
    this.cached = { runtimeIdentityID, client, lease };
    return client;
  }

  dispose(): void {
    const cached = this.cached;
    this.cached = null;
    if (cached) {
      cached.lease.active = false;
      cached.client.disconnect();
    }
  }
}
