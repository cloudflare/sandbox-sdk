import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  MountCommandResult,
  MountS3FSRequest,
  RemoveMountDirectoryRequest
} from '@repo/shared';
import { MountsRPCAPI } from '../../src/control-plane/mounts-rpc';

interface MountServiceStub {
  pathExists(path: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  chmodOwnerOnly(path: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  mountS3FS(request: MountS3FSRequest): Promise<MountCommandResult>;
  mountS3FSAndVerify(request: MountS3FSRequest): Promise<MountCommandResult>;
  isMountpoint(path: string): Promise<boolean>;
  unmountFuse(path: string): Promise<MountCommandResult>;
  unmountFuseIfMounted(path: string): Promise<void>;
  removeMountDirectory(
    request: RemoveMountDirectoryRequest
  ): Promise<MountCommandResult>;
}

function commandResult(command = 'mount'): MountCommandResult {
  return {
    success: true,
    exitCode: 0,
    stdout: command,
    stderr: ''
  };
}

describe('MountsRPCAPI domain', () => {
  let mountService: MountServiceStub;

  beforeEach(() => {
    vi.clearAllMocks();
    mountService = {
      pathExists: vi.fn(async () => true),
      ensureDirectory: vi.fn(async () => undefined),
      chmodOwnerOnly: vi.fn(async () => undefined),
      deleteFile: vi.fn(async () => undefined),
      mountS3FS: vi.fn(async () => commandResult('s3fs')),
      mountS3FSAndVerify: vi.fn(async () =>
        commandResult('s3fs && mountpoint')
      ),
      isMountpoint: vi.fn(async () => false),
      unmountFuse: vi.fn(async () => commandResult('fusermount3 -u')),
      unmountFuseIfMounted: vi.fn(async () => undefined),
      removeMountDirectory: vi.fn(async () => commandResult('rm -rf'))
    };
  });

  it('exposes only the focused specialized mount RPC domain', () => {
    const api = new MountsRPCAPI(mountService);

    expect(api.pathExists).toEqual(expect.any(Function));
    expect(api.ensureDirectory).toEqual(expect.any(Function));
    expect(api.chmodOwnerOnly).toEqual(expect.any(Function));
    expect(api.deleteFile).toEqual(expect.any(Function));
    expect(api.mountS3FS).toEqual(expect.any(Function));
    expect(api.mountS3FSAndVerify).toEqual(expect.any(Function));
    expect(api.isMountpoint).toEqual(expect.any(Function));
    expect(api.unmountFuse).toEqual(expect.any(Function));
    expect(api.unmountFuseIfMounted).toEqual(expect.any(Function));
    expect(api.removeMountDirectory).toEqual(expect.any(Function));
    expect('runInternalCommand' in api).toBe(false);
    expect('runCommand' in api).toBe(false);
    expect('exec' in api).toBe(false);
  });

  it('delegates lifecycle helpers to MountService without reshaping results', async () => {
    const api = new MountsRPCAPI(mountService);

    expect(await api.pathExists('/mnt/data')).toBe(true);
    await api.ensureDirectory('/mnt/data');
    await api.chmodOwnerOnly('/tmp/passwd');
    await api.deleteFile('/tmp/passwd');
    expect(await api.isMountpoint('/mnt/data')).toBe(false);
    await api.unmountFuseIfMounted('/mnt/data');

    expect(mountService.pathExists).toHaveBeenCalledWith('/mnt/data');
    expect(mountService.ensureDirectory).toHaveBeenCalledWith('/mnt/data');
    expect(mountService.chmodOwnerOnly).toHaveBeenCalledWith('/tmp/passwd');
    expect(mountService.deleteFile).toHaveBeenCalledWith('/tmp/passwd');
    expect(mountService.isMountpoint).toHaveBeenCalledWith('/mnt/data');
    expect(mountService.unmountFuseIfMounted).toHaveBeenCalledWith('/mnt/data');
  });

  it('delegates specialized mount commands to MountService', async () => {
    const api = new MountsRPCAPI(mountService);
    const mountRequest = {
      source: 'bucket',
      mountPath: '/mnt/data',
      options: { passwd_file: '/tmp/passwd', ro: true, url: 'https://r2' }
    };
    const removeRequest = { path: '/mnt/data', onlyIfNotMountpoint: true };

    expect(await api.mountS3FS(mountRequest)).toEqual(commandResult('s3fs'));
    expect(await api.mountS3FSAndVerify(mountRequest)).toEqual(
      commandResult('s3fs && mountpoint')
    );
    expect(await api.unmountFuse('/mnt/data')).toEqual(
      commandResult('fusermount3 -u')
    );
    expect(await api.removeMountDirectory(removeRequest)).toEqual(
      commandResult('rm -rf')
    );
    expect(mountService.mountS3FS).toHaveBeenCalledWith(mountRequest);
    expect(mountService.mountS3FSAndVerify).toHaveBeenCalledWith(mountRequest);
    expect(mountService.unmountFuse).toHaveBeenCalledWith('/mnt/data');
    expect(mountService.removeMountDirectory).toHaveBeenCalledWith(
      removeRequest
    );
  });
});
