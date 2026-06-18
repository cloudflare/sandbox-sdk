import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { FileService } from '@sandbox-container/services/file-service';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

function buildApi(fileService: FileService): SandboxControlAPI {
  return new SandboxControlAPI({
    fileService,
    logger: mockLogger
  } as unknown as SandboxAPIDeps);
}

describe('SandboxControlAPI files', () => {
  let mockFileService: FileService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFileService = {
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
      readFileBinaryStream: vi.fn().mockResolvedValue({
        success: true,
        data: {
          content: new ReadableStream<Uint8Array>(),
          size: 7,
          mimeType: 'application/octet-stream'
        }
      }),
      readFileStreamOperation: vi
        .fn()
        .mockResolvedValue(new ReadableStream<Uint8Array>()),
      writeFile: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      writeFileStream: vi.fn().mockResolvedValue({
        success: true,
        data: { bytesWritten: 7 }
      }),
      deleteFile: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      renameFile: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      moveFile: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      createDirectory: vi
        .fn()
        .mockResolvedValue({ success: true, data: undefined }),
      listFiles: vi.fn().mockResolvedValue({ success: true, data: [] }),
      exists: vi.fn().mockResolvedValue({ success: true, data: true })
    } as unknown as FileService;
  });

  it('accepts file options with sessionId inside the options object', async () => {
    const api = buildApi(mockFileService);
    const stream = new ReadableStream<Uint8Array>();

    await api.files.readFile('/workspace/file.txt', {
      sessionId: 'session-1',
      encoding: 'utf8'
    });
    await api.files.readFile('/workspace/raw.bin', {
      sessionId: 'session-1',
      encoding: 'none'
    });
    await api.files.readFileStream('/workspace/file.txt', {
      sessionId: 'session-1'
    });
    await api.files.writeFile('/workspace/file.txt', 'content', {
      sessionId: 'session-1',
      encoding: 'utf8',
      permissions: '0644'
    });
    await api.files.writeFileStream('/workspace/stream.txt', stream, {
      sessionId: 'session-1'
    });
    await api.files.deleteFile('/workspace/file.txt', {
      sessionId: 'session-1'
    });
    await api.files.renameFile('/workspace/old.txt', '/workspace/new.txt', {
      sessionId: 'session-1'
    });
    await api.files.moveFile('/workspace/src.txt', '/workspace/dest.txt', {
      sessionId: 'session-1'
    });
    await api.files.mkdir('/workspace/dir', {
      sessionId: 'session-1',
      recursive: true
    });
    await api.files.listFiles('/workspace', {
      sessionId: 'session-1',
      includeHidden: true
    });
    await api.files.exists('/workspace/file.txt', { sessionId: 'session-1' });

    expect(mockFileService.readFile).toHaveBeenCalledWith(
      '/workspace/file.txt',
      { encoding: 'utf8' },
      'session-1'
    );
    expect(mockFileService.readFileBinaryStream).toHaveBeenCalledWith(
      '/workspace/raw.bin',
      'session-1'
    );
    expect(mockFileService.readFileStreamOperation).toHaveBeenCalledWith(
      '/workspace/file.txt',
      'session-1'
    );
    expect(mockFileService.writeFile).toHaveBeenCalledWith(
      '/workspace/file.txt',
      'content',
      { encoding: 'utf8', permissions: '0644' },
      'session-1'
    );
    expect(mockFileService.writeFileStream).toHaveBeenCalledWith(
      '/workspace/stream.txt',
      stream,
      'session-1'
    );
    expect(mockFileService.deleteFile).toHaveBeenCalledWith(
      '/workspace/file.txt',
      'session-1'
    );
    expect(mockFileService.renameFile).toHaveBeenCalledWith(
      '/workspace/old.txt',
      '/workspace/new.txt',
      'session-1'
    );
    expect(mockFileService.moveFile).toHaveBeenCalledWith(
      '/workspace/src.txt',
      '/workspace/dest.txt',
      'session-1'
    );
    expect(mockFileService.createDirectory).toHaveBeenCalledWith(
      '/workspace/dir',
      { recursive: true },
      'session-1'
    );
    expect(mockFileService.listFiles).toHaveBeenCalledWith(
      '/workspace',
      { includeHidden: true },
      'session-1'
    );
    expect(mockFileService.exists).toHaveBeenCalledWith(
      '/workspace/file.txt',
      'session-1'
    );
  });
});
