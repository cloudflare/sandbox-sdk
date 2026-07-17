import { describe, expect, it, vi } from 'vitest';
import type { CommandContextService } from '../../src/services/command-context-service';
import { MountService } from '../../src/services/mount-service';

function createService() {
  const run = vi.fn(async (_command: string) => ({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
    command: '',
    duration: 0,
    timestamp: new Date().toISOString()
  }));
  const service = new MountService({ run } as unknown as CommandContextService);
  return { service, run };
}

describe('MountService', () => {
  it('escapes path boundaries for directory lifecycle operations', async () => {
    const { service, run } = createService();

    await service.ensureDirectory("/mnt/has space'and quote");
    await service.chmodOwnerOnly('/tmp/pass wd');
    await service.deleteFile('/tmp/pass;rm -rf /');

    expect(run).toHaveBeenNthCalledWith(
      1,
      "mkdir -p '/mnt/has space'\\''and quote'",
      { cwd: '/workspace' }
    );
    expect(run).toHaveBeenNthCalledWith(2, "chmod 0600 '/tmp/pass wd'", {
      cwd: '/workspace'
    });
    expect(run).toHaveBeenNthCalledWith(3, "rm -f '/tmp/pass;rm -rf /'", {
      cwd: '/workspace'
    });
  });

  it('serializes structured s3fs requests without accepting scripts', async () => {
    const { service, run } = createService();

    await service.mountS3FS({
      source: 'bucket;echo nope',
      mountPath: '/mnt/data',
      options: { passwd_file: '/tmp/pass file', ro: true, url: 'https://r2' }
    });

    expect(run).toHaveBeenCalledWith(
      "s3fs 'bucket;echo nope' '/mnt/data' -o 'passwd_file=/tmp/pass file,ro,url=https://r2'",
      { cwd: '/workspace' }
    );
  });

  it('returns mount/check/unmount command results semantically', async () => {
    const { service, run } = createService();
    run.mockResolvedValueOnce({
      success: false,
      exitCode: 7,
      stdout: 'out',
      stderr: 'err',
      command: '',
      duration: 0,
      timestamp: new Date().toISOString()
    });

    await expect(service.isMountpoint('/mnt/data')).resolves.toBe(false);
    const result = await service.unmountFuse('/mnt/data');

    expect(run).toHaveBeenNthCalledWith(1, "mountpoint -q '/mnt/data'", {
      cwd: '/workspace'
    });
    expect(result).toMatchObject({ success: true, exitCode: 0 });
  });

  it('rejects malformed structured paths before shell construction', async () => {
    const { service, run } = createService();

    await expect(service.ensureDirectory('')).rejects.toThrow(
      'path must be a non-empty path without NUL bytes'
    );
    await expect(service.deleteFile('/tmp/bad\0path')).rejects.toThrow(
      'path must be a non-empty path without NUL bytes'
    );
    await expect(
      service.mountS3FS({ source: '', mountPath: '/mnt/data', options: {} })
    ).rejects.toThrow('source must be a non-empty path without NUL bytes');

    expect(run).not.toHaveBeenCalled();
  });

  it('rejects malformed structured options before shell construction', async () => {
    const { service, run } = createService();

    await expect(
      service.mountS3FS({
        source: 'bucket',
        mountPath: '/mnt/data',
        options: { '': true }
      })
    ).rejects.toThrow(
      'option keys must be non-empty strings without NUL bytes'
    );
    await expect(
      service.mountS3FS({
        source: 'bucket',
        mountPath: '/mnt/data',
        options: { passwd_file: '' }
      })
    ).rejects.toThrow(
      'option values must be true or non-empty strings without NUL bytes'
    );

    expect(run).not.toHaveBeenCalled();
  });

  it('runs verified s3fs with log-tail failure cleanup boundary', async () => {
    const { service, run } = createService();
    run.mockResolvedValueOnce({
      success: false,
      exitCode: 3,
      stdout: 'tail',
      stderr: '',
      command: '',
      duration: 0,
      timestamp: new Date().toISOString()
    });

    const result = await service.mountS3FSAndVerify({
      source: 'bucket',
      mountPath: '/mnt/data',
      options: { logfile: '/tmp/s3fs.log', passwd_file: '/tmp/pass' }
    });

    expect(result).toMatchObject({
      success: false,
      exitCode: 3,
      stdout: 'tail'
    });
    expect(run.mock.calls[0][0]).toContain("tail -n 20 '/tmp/s3fs.log'");
    expect(run.mock.calls[0][0]).toContain("mountpoint -q '/mnt/data'");
  });
});
