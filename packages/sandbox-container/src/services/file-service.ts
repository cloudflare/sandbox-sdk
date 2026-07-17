import type { FileInfo, ListFilesOptions } from '@repo/shared';
import type {
  FileMetadata,
  FileStats,
  MkdirOptions,
  ReadOptions,
  ServiceResult,
  WriteOptions
} from '../core/types';
import { FileStreamOperations } from './files/stream-operations';

export interface SecurityService {
  validatePath(path: string): { isValid: boolean; errors: string[] };
}

export interface FileSystemOperations {
  read(
    path: string,
    options?: ReadOptions
  ): Promise<ServiceResult<string, FileMetadata>>;
  write(
    path: string,
    content: string,
    options?: WriteOptions
  ): Promise<ServiceResult<void>>;
  delete(path: string): Promise<ServiceResult<void>>;
  rename(oldPath: string, newPath: string): Promise<ServiceResult<void>>;
  move(
    sourcePath: string,
    destinationPath: string
  ): Promise<ServiceResult<void>>;
  mkdir(path: string, options?: MkdirOptions): Promise<ServiceResult<void>>;
  exists(path: string): Promise<ServiceResult<boolean>>;
  stat(path: string): Promise<ServiceResult<FileStats>>;
  list(
    path: string,
    options?: ListFilesOptions
  ): Promise<ServiceResult<FileInfo[]>>;
}

export class FileService
  extends FileStreamOperations
  implements FileSystemOperations {}
