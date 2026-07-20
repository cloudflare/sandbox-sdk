import { describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import type { SandboxAPIDeps } from '@sandbox-container/control-plane';
import type { FileService } from '@sandbox-container/services/file-service';
import { createActivatedSandboxControlAPI } from './session-helper';

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
logger.child = vi.fn(() => logger);

describe('SandboxControlAPI files', () => {
  it('forwards stateless file calls to workspace paths', async () => {
    const fileService = {
      readFile: vi.fn().mockResolvedValue({
        success: true,
        data: 'content',
        metadata: {
          encoding: 'utf-8',
          isBinary: false,
          mimeType: 'text/plain',
          size: 7
        }
      }),
      writeFile: vi.fn().mockResolvedValue({ success: true }),
      exists: vi.fn().mockResolvedValue({ success: true, data: true })
    } as unknown as FileService;
    const api = await createActivatedSandboxControlAPI({
      fileService,
      logger
    } as unknown as SandboxAPIDeps);

    await api.files.readFile('/workspace/file.txt', { encoding: 'utf8' });
    await api.files.writeFile('/workspace/file.txt', 'content');
    await api.files.exists('/workspace/file.txt');

    expect(fileService.readFile).toHaveBeenCalledWith('/workspace/file.txt', {
      encoding: 'utf8'
    });
    expect(fileService.writeFile).toHaveBeenCalledWith(
      '/workspace/file.txt',
      'content',
      {}
    );
    expect(fileService.exists).toHaveBeenCalledWith('/workspace/file.txt');
  });
});
