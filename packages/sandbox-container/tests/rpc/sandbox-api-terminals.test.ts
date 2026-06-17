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
      destroyTerminal: vi.fn(async () => undefined)
    } as unknown as TerminalManager;
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
