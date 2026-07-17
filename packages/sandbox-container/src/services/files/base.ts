import { resolve } from 'node:path';
import type { Logger } from '@repo/shared';
import type { FileSystemContext } from '@repo/shared/errors';
import { ErrorCode, Operation } from '@repo/shared/errors';
import {
  type ServiceError,
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../../core/types';
import { FileManager } from '../../managers/file-manager';
import type {
  CommandContextService,
  ContextExec
} from '../command-context-service';
import type { SecurityService } from '../file-service';
import type { InternalCommandResult } from '../internal-command-result';

export const MAX_ENCODED_FILE_SIZE = 32 * 1_048_576;

export const TEXT_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/json-seq',
  'application/rtf',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-empty',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-typescript',
  'application/x-yaml',
  'application/xml',
  'application/xml-dtd',
  'application/xml-external-parsed-entity',
  'application/yaml',
  'inode/x-empty'
]);

export class FileOperationBase {
  protected manager: FileManager;

  constructor(
    protected security: SecurityService,
    protected logger: Logger,
    protected commandContextService: CommandContextService
  ) {
    this.manager = new FileManager();
  }

  protected async withExecutionInternal<T>(
    fn: (exec: ContextExec) => Promise<T>
  ): Promise<ServiceResult<T>> {
    try {
      const data = await this.commandContextService.withExecution({}, fn);
      return serviceSuccess(data);
    } catch (error) {
      return serviceError(this.toServiceError(error));
    }
  }

  protected toServiceError(error: unknown): ServiceError {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      'message' in error &&
      typeof (error as Record<string, unknown>).code === 'string' &&
      typeof (error as Record<string, unknown>).message === 'string'
    ) {
      return error as ServiceError;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      code: ErrorCode.INTERNAL_ERROR
    };
  }

  protected async executeInternal(
    command: string,
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
    } = {}
  ): Promise<ServiceResult<InternalCommandResult>> {
    try {
      const result = await this.commandContextService.run(command, {
        ...options
      });
      return serviceSuccess(result);
    } catch (error) {
      return serviceError(this.toServiceError(error));
    }
  }

  protected modeToString(mode: number): string {
    const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
    const owner = perms[(mode >> 6) & 7];
    const group = perms[(mode >> 3) & 7];
    const other = perms[mode & 7];
    return `${owner}${group}${other}`;
  }

  protected getPermissions(mode: number): {
    readable: boolean;
    writable: boolean;
    executable: boolean;
  } {
    return {
      readable: (mode & 0o400) !== 0,
      writable: (mode & 0o200) !== 0,
      executable: (mode & 0o100) !== 0
    };
  }

  protected isBinaryMimeType(mimeType: string): boolean {
    const normalizedMimeType = mimeType.split(';')[0].trim().toLowerCase();
    const subtype = normalizedMimeType.split('/')[1] ?? '';

    return !(
      normalizedMimeType.startsWith('text/') ||
      TEXT_MIME_TYPES.has(normalizedMimeType) ||
      subtype.endsWith('+json') ||
      subtype.endsWith('+xml')
    );
  }

  protected async resolvePathInExecutionContext(
    path: string,
    exec: (
      command: string,
      options?: {
        cwd?: string;
        env?: Record<string, string | undefined>;
      }
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  ): Promise<string> {
    if (path.startsWith('/')) {
      return path;
    }

    const pwdResult = await exec('pwd');
    if (pwdResult.exitCode !== 0) {
      throw {
        code: ErrorCode.FILESYSTEM_ERROR,
        message: `Failed to resolve working directory for '${path}'`,
        details: {
          path,
          operation: Operation.FILE_READ,
          exitCode: pwdResult.exitCode,
          stderr: pwdResult.stderr
        } satisfies FileSystemContext
      };
    }

    const cwd = pwdResult.stdout.trim();
    return resolve(cwd, path);
  }
}
