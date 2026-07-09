import {
  type MountCommandResult,
  type MountS3FSRequest,
  type RemoveMountDirectoryRequest,
  type S3FSOptionValue,
  shellEscape
} from '@repo/shared';
import type { CommandContextService } from './command-context-service';

function assertStructuredPath(path: string, label: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty path without NUL bytes`);
  }
}

function assertS3FSOptions(
  options: Record<string, S3FSOptionValue>
): asserts options is Record<string, S3FSOptionValue> {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError('options must be a structured object');
  }
  for (const [key, value] of Object.entries(options)) {
    if (key.length === 0 || key.includes('\0')) {
      throw new TypeError(
        'option keys must be non-empty strings without NUL bytes'
      );
    }
    if (
      value !== true &&
      (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    ) {
      throw new TypeError(
        'option values must be true or non-empty strings without NUL bytes'
      );
    }
  }
}

function serializeS3FSOptions(
  options: Record<string, S3FSOptionValue>
): string {
  assertS3FSOptions(options);
  return Object.entries(options)
    .map(([key, value]) => (value === true ? key : `${key}=${value}`))
    .join(',');
}

export class MountService {
  constructor(private readonly commands: CommandContextService) {}

  async pathExists(path: string): Promise<boolean> {
    assertStructuredPath(path, 'path');
    const result = await this.commands.run(`test -d ${shellEscape(path)}`, {
      cwd: '/workspace'
    });
    return result.exitCode === 0;
  }

  async ensureDirectory(path: string): Promise<void> {
    assertStructuredPath(path, 'path');
    await this.commands.run(`mkdir -p ${shellEscape(path)}`, {
      cwd: '/workspace'
    });
  }

  async chmodOwnerOnly(path: string): Promise<void> {
    assertStructuredPath(path, 'path');
    await this.commands.run(`chmod 0600 ${shellEscape(path)}`, {
      cwd: '/workspace'
    });
  }

  async deleteFile(path: string): Promise<void> {
    assertStructuredPath(path, 'path');
    await this.commands.run(`rm -f ${shellEscape(path)}`, {
      cwd: '/workspace'
    });
  }

  async mountS3FS(request: MountS3FSRequest): Promise<MountCommandResult> {
    assertStructuredPath(request.source, 'source');
    assertStructuredPath(request.mountPath, 'mountPath');
    const options = shellEscape(serializeS3FSOptions(request.options));
    const result = await this.commands.run(
      `s3fs ${shellEscape(request.source)} ${shellEscape(request.mountPath)} -o ${options}`,
      { cwd: '/workspace' }
    );
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async mountS3FSAndVerify(
    request: MountS3FSRequest
  ): Promise<MountCommandResult> {
    assertStructuredPath(request.source, 'source');
    assertStructuredPath(request.mountPath, 'mountPath');
    const options = serializeS3FSOptions(request.options);
    const logFile =
      typeof request.options.logfile === 'string'
        ? request.options.logfile
        : undefined;
    if (!logFile) {
      return this.mountS3FS(request);
    }

    const script = `(
      s3fs ${shellEscape(request.source)} ${shellEscape(request.mountPath)} -o ${shellEscape(options)} >${shellEscape(logFile)} 2>&1
      rc=$?
      if [ "$rc" -ne 0 ]; then tail -n 20 ${shellEscape(logFile)} 2>/dev/null || true; exit 2; fi
      for _ in $(seq 1 60); do
        if mountpoint -q ${shellEscape(request.mountPath)}; then exit 0; fi
        sleep 0.1
      done
      tail -n 20 ${shellEscape(logFile)} 2>/dev/null || true
      exit 3
    )`;
    const result = await this.commands.run(script, { cwd: '/workspace' });
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async isMountpoint(path: string): Promise<boolean> {
    assertStructuredPath(path, 'path');
    const result = await this.commands.run(
      `mountpoint -q ${shellEscape(path)}`,
      {
        cwd: '/workspace'
      }
    );
    return result.exitCode === 0;
  }

  async unmountFuse(path: string): Promise<MountCommandResult> {
    assertStructuredPath(path, 'path');
    const result = await this.commands.run(
      `fusermount -u ${shellEscape(path)}`,
      {
        cwd: '/workspace'
      }
    );
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async unmountFuseIfMounted(path: string): Promise<void> {
    assertStructuredPath(path, 'path');
    await this.commands.run(
      `mountpoint -q ${shellEscape(path)} && fusermount -u ${shellEscape(path)}`,
      { cwd: '/workspace' }
    );
  }

  async removeMountDirectory(
    request: RemoveMountDirectoryRequest
  ): Promise<MountCommandResult> {
    assertStructuredPath(request.path, 'path');
    if (typeof request.onlyIfNotMountpoint !== 'boolean') {
      throw new TypeError('onlyIfNotMountpoint must be a boolean');
    }
    const command = request.onlyIfNotMountpoint
      ? `mountpoint -q ${shellEscape(request.path)} || rmdir ${shellEscape(request.path)}`
      : `rmdir ${shellEscape(request.path)} 2>/dev/null`;
    const result = await this.commands.run(command, { cwd: '/workspace' });
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}
