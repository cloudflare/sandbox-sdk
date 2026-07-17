import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SandboxWatchAPI, WatchRequest } from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { WatchService } from '@sandbox-container/services/watch-service';

function buildApi(watchService: WatchService): SandboxControlAPI {
  return new SandboxControlAPI({ watchService } as SandboxAPIDeps);
}

describe('SandboxControlAPI watch', () => {
  let watchDirectory: ReturnType<typeof mock>;
  let watch: SandboxWatchAPI;

  beforeEach(() => {
    watchDirectory = mock();
    const service = { watchDirectory } as unknown as WatchService;
    watch = buildApi(service).watch;
  });

  it('owns watch streams through a disposable subscription', async () => {
    const sourceCancel = mock(() => undefined);
    const chunk = new Uint8Array([65]);
    watchDirectory.mockResolvedValue({
      success: true,
      data: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
        },
        cancel: sourceCancel
      })
    });
    const request: WatchRequest = { path: '/workspace', recursive: true };

    const subscription = await watch.watch(request);
    const reader = (await subscription.stream()).getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: chunk });
    await subscription.cancel();
    subscription[Symbol.dispose]();

    expect(sourceCancel).toHaveBeenCalledTimes(1);
    expect(watchDirectory).toHaveBeenCalledWith('/workspace', request);
  });
});
