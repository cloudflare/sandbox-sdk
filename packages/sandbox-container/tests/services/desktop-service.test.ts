import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import { DesktopManager } from '@sandbox-container/managers/desktop-manager';
import { DesktopService } from '@sandbox-container/services/desktop-service';

describe('DesktopService', () => {
  let service: DesktopService;

  beforeEach(() => {
    service = new DesktopService(createNoOpLogger());
  });

  test('constructor creates desktop manager', () => {
    expect((service as any).manager).toBeInstanceOf(DesktopManager);
  });

  test('status returns inactive when desktop has not started', async () => {
    const result = await service.status();
    expect(result.success).toBe(true);

    if (!result.success) {
      throw new Error('Expected success result for status');
    }

    expect(result.data.status).toBe('inactive');
    expect(result.data.processes).toEqual({});
    expect(result.data.resolution).toBeNull();
    expect(result.data.dpi).toBeNull();
  });

  test('getProcessStatus returns DESKTOP_NOT_STARTED for unknown process', async () => {
    const result = await service.getProcessStatus('nonexistent');
    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error('Expected failure result for missing process');
    }

    expect(result.error.code).toBe('DESKTOP_NOT_STARTED');
    expect(result.error.message).toContain("Process 'nonexistent' not found");
  });

  test('ensureDesktopActive guard throws when desktop is inactive', () => {
    const mockManager = {
      getStatus: mock(() => ({ status: 'inactive', processes: {} }))
    };

    (service as any).manager = mockManager;

    expect(() => (service as any).ensureDesktopActive()).toThrow(
      'Desktop is not running. Call start() first.'
    );
  });

  test('destroy is safe when desktop was never started', async () => {
    const mockManager = {
      stop: mock(() => Promise.resolve())
    };

    (service as any).manager = mockManager;
    (service as any).worker = null;

    await expect(service.destroy()).resolves.toBeUndefined();
    expect(mockManager.stop).toHaveBeenCalledTimes(1);
  });
});
