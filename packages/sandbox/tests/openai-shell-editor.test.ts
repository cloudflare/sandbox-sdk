import type { ApplyPatchOperation } from '@openai/agents';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, Shell } from '../src/openai/index.ts';

const { loggerSpies, createLoggerMock, applyDiffMock } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis()
  };

  return {
    loggerSpies: logger,
    createLoggerMock: vi.fn(() => logger),
    applyDiffMock: vi.fn<(...args: any[]) => string>()
  };
});

vi.mock('@repo/shared', () => ({
  createLogger: createLoggerMock
}));

vi.mock('@openai/agents', () => ({
  applyDiff: applyDiffMock
}));

describe('Shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs commands and collects results', async () => {
    const execMock = vi.fn().mockResolvedValue({
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0
    });

    const shell = new Shell({ exec: execMock } as unknown as any);

    const result = await shell.run({
      commands: ['echo hello'],
      timeoutMs: 500
    });

    expect(execMock).toHaveBeenCalledWith('echo hello', {
      timeout: 500,
      cwd: '/workspace'
    });
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({
      command: 'echo hello',
      stdout: 'hello\n',
      stderr: '',
      outcome: { type: 'exit', exitCode: 0 }
    });
    expect(shell.results).toHaveLength(1);
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Command completed successfully',
      { command: 'echo hello' }
    );
  });

  it('halts subsequent commands after a timeout error', async () => {
    const timeoutError = new Error('Command timed out');
    const execMock = vi.fn().mockRejectedValue(timeoutError);

    const shell = new Shell({ exec: execMock } as unknown as any);
    const action = {
      commands: ['sleep 1', 'echo never'],
      timeoutMs: 25
    };

    const result = await shell.run(action);

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(result.output[0].outcome).toEqual({ type: 'timeout' });
    expect(shell.results[0].exitCode).toBeNull();
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'Breaking command loop due to timeout'
    );
    expect(loggerSpies.error).toHaveBeenCalledWith(
      'Command timed out',
      undefined,
      expect.objectContaining({
        command: 'sleep 1',
        timeout: 25
      })
    );
  });
});

describe('Editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDiffMock.mockReset();
  });

  it('creates files using applyDiff output', async () => {
    applyDiffMock.mockReturnValueOnce('file contents');

    const sandbox = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    };

    const editor = new Editor(sandbox as unknown as any);
    const operation = {
      type: 'create_file',
      path: 'src/app.ts',
      diff: '--- diff ---'
    } as Extract<ApplyPatchOperation, { type: 'create_file' }>;

    await editor.createFile(operation);

    expect(applyDiffMock).toHaveBeenCalledWith('', operation.diff, 'create');
    expect(sandbox.mkdir).toHaveBeenCalledWith('/workspace/src', {
      recursive: true
    });
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      '/workspace/src/app.ts',
      'file contents',
      { encoding: 'utf-8' }
    );
    expect(editor.results[0]).toMatchObject({
      operation: 'create',
      path: 'src/app.ts',
      status: 'completed'
    });
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'File created successfully',
      expect.objectContaining({ path: 'src/app.ts' })
    );
  });

  it('applies diffs when updating existing files', async () => {
    applyDiffMock.mockReturnValueOnce('patched content');

    const sandbox = {
      readFile: vi.fn().mockResolvedValue({ content: 'original content' }),
      writeFile: vi.fn().mockResolvedValue(undefined)
    };

    const editor = new Editor(sandbox as unknown as any);
    const operation = {
      type: 'update_file',
      path: 'README.md',
      diff: 'patch diff'
    } as Extract<ApplyPatchOperation, { type: 'update_file' }>;

    await editor.updateFile(operation);

    expect(sandbox.readFile).toHaveBeenCalledWith('/workspace/README.md', {
      encoding: 'utf-8'
    });
    expect(applyDiffMock).toHaveBeenCalledWith(
      'original content',
      operation.diff
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      '/workspace/README.md',
      'patched content',
      { encoding: 'utf-8' }
    );
    expect(editor.results[0]).toMatchObject({
      operation: 'update',
      path: 'README.md',
      status: 'completed'
    });
  });

  it('throws descriptive error when attempting to update a missing file', async () => {
    const missingError = Object.assign(new Error('not found'), { status: 404 });
    const sandbox = {
      readFile: vi.fn().mockRejectedValue(missingError)
    };

    const editor = new Editor(sandbox as unknown as any);
    const operation = {
      type: 'update_file',
      path: 'missing.txt',
      diff: 'patch diff'
    } as Extract<ApplyPatchOperation, { type: 'update_file' }>;

    await expect(editor.updateFile(operation)).rejects.toThrow(
      'Cannot update missing file: missing.txt'
    );
    expect(loggerSpies.error).toHaveBeenCalledWith(
      'Cannot update missing file',
      undefined,
      { path: 'missing.txt' }
    );
  });
});
