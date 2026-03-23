import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { createSupervisorController } from '../src/main';

const mockLogger = createNoOpLogger();

describe('createSupervisorController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards shutdown signal to a running child, cleans up, and exits', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const kill = vi.fn().mockReturnValue(true);
    const child = {
      exitCode: null,
      kill
    };

    const controller = createSupervisorController({
      cleanup,
      getChild: () => child,
      exit,
      logger: mockLogger
    });

    await controller.onSignal('SIGTERM');

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still shuts down when the child already exited', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const kill = vi.fn().mockReturnValue(true);
    const child = {
      exitCode: 0,
      kill
    };

    const controller = createSupervisorController({
      cleanup,
      getChild: () => child,
      exit,
      logger: mockLogger
    });

    await controller.onSignal('SIGTERM');

    expect(kill).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not exit from child signal events once shutdown has started', async () => {
    let resolveCleanup!: () => void;
    const cleanup = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        })
    );
    const exit = vi.fn();
    const kill = vi.fn().mockReturnValue(true);
    const child = {
      exitCode: null,
      kill
    };

    const controller = createSupervisorController({
      cleanup,
      getChild: () => child,
      exit,
      logger: mockLogger
    });

    const shutdown = controller.onSignal('SIGTERM');
    controller.onChildExit(null, 'SIGTERM');

    expect(exit).not.toHaveBeenCalled();

    resolveCleanup();
    await shutdown;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('preserves existing child exit behaviour outside shutdown', () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    const controller = createSupervisorController({
      cleanup,
      getChild: () => null,
      exit,
      logger: mockLogger
    });

    controller.onChildExit(null, 'SIGTERM');

    expect(exit).toHaveBeenCalledWith(143);
  });

  it('does not exit when child exits with code 0 outside shutdown', () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    const controller = createSupervisorController({
      cleanup,
      getChild: () => null,
      exit,
      logger: mockLogger
    });

    controller.onChildExit(0, null);

    expect(exit).not.toHaveBeenCalled();
  });

  it('exits with child exit code on non-zero exit outside shutdown', () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    const controller = createSupervisorController({
      cleanup,
      getChild: () => null,
      exit,
      logger: mockLogger
    });

    controller.onChildExit(1, null);

    expect(exit).toHaveBeenCalledWith(1);
  });
});
