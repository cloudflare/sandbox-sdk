import { describe, expect, it, vi } from 'bun:test';
import type { Logger, PortWatchEvent } from '@repo/shared';
import type { SandboxAPIDeps } from '@sandbox-container/control-plane';
import type { PortService } from '@sandbox-container/services/port-service';
import { StreamSubscriptionRPC } from '../../src/control-plane/subscription-rpc';
import { createActivatedSandboxControlAPI } from './session-helper';

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
logger.child = vi.fn(() => logger);

describe('SandboxControlAPI ports', () => {
  it('returns disposable typed port watch subscriptions', async () => {
    const stream = new ReadableStream<PortWatchEvent>({
      start(controller) {
        controller.enqueue({ type: 'watching', port: 8787 });
        controller.close();
      }
    });
    const portService = {
      openWatch: vi.fn(() => stream)
    } as unknown as PortService;
    const api = await createActivatedSandboxControlAPI({
      portService,
      logger
    } as unknown as SandboxAPIDeps);

    const subscription = await api.ports.openWatch(8787, {
      mode: 'http',
      path: '/health',
      status: 204,
      interval: 250
    });

    expect(subscription).toBeInstanceOf(StreamSubscriptionRPC);
    expect(portService.openWatch).toHaveBeenCalledWith(8787, {
      mode: 'http',
      path: '/health',
      status: 204,
      interval: 250
    });
    expect('watchPort' in api.ports).toBe(false);
  });
});
