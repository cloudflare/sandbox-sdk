import type { SandboxWatchAPI } from './rpc-types';
import type { WatchRequest } from './types';

export const DISABLE_SESSION_TOKEN = '__DISABLE_SESSION__';
export const WORKSPACE_ROOT = '/workspace';
export const WATCH_LOCAL_MOUNT = Symbol('watch-local-mount');

export interface InternalSandboxWatchAPI extends SandboxWatchAPI {
  watchMount(request: WatchRequest): Promise<ReadableStream<Uint8Array>>;
}

export interface LocalMountWatchClient {
  [WATCH_LOCAL_MOUNT](
    request: WatchRequest
  ): Promise<ReadableStream<Uint8Array>>;
}
