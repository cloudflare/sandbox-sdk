import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { TerminalManager } from '@sandbox-container/services/terminal-manager';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

function buildApi(terminalManager: TerminalManager): SandboxControlAPI {
  return new SandboxControlAPI({
    terminalManager,
    logger: mockLogger
  } as unknown as SandboxAPIDeps);
}

describe('SandboxControlAPI terminals', () => {
  let mockTerminalManager: TerminalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminalManager = {
      getOrCreateTerminal: vi.fn(async (options: { id: string }) => ({
        id: options.id,
        pty: {}
      })),
      destroyTerminal: vi.fn(async () => undefined)
    } as unknown as TerminalManager;
  });

  it('creates terminal resources through TerminalManager', async () => {
    const api = buildApi(mockTerminalManager) as SandboxControlAPI & {
      terminals: {
        createTerminal(options: {
          id: string;
          cwd?: string;
          shell?: string;
          cols?: number;
          rows?: number;
        }): Promise<{ success: true; id: string }>;
      };
    };

    const result = await api.terminals.createTerminal({
      id: 'terminal-a',
      cwd: '/workspace/app',
      shell: '/bin/bash',
      cols: 120,
      rows: 40
    });

    expect(result).toEqual({ success: true, id: 'terminal-a' });
    expect(mockTerminalManager.getOrCreateTerminal).toHaveBeenCalledWith({
      id: 'terminal-a',
      cwd: '/workspace/app',
      pty: { shell: '/bin/bash', cols: 120, rows: 40 }
    });
  });

  it('destroys terminal resources through TerminalManager', async () => {
    const api = buildApi(mockTerminalManager) as SandboxControlAPI & {
      terminals: {
        destroyTerminal(id: string): Promise<{ success: true; id: string }>;
      };
    };

    const result = await api.terminals.destroyTerminal('terminal-a');

    expect(result).toEqual({ success: true, id: 'terminal-a' });
    expect(mockTerminalManager.destroyTerminal).toHaveBeenCalledWith(
      'terminal-a'
    );
  });
});
