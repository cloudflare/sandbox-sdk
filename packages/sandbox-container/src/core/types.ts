export type ValidationResult<T = unknown> =
  | {
      isValid: true;
      data: T;
      errors: ValidationError[];
    }
  | {
      isValid: false;
      data?: undefined;
      errors: ValidationError[];
    };

interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export type ServiceResult<T, M = Record<string, unknown>> = T extends void
  ?
      | {
          success: true;
          metadata?: M;
        }
      | {
          success: false;
          error: ServiceError;
        }
  :
      | {
          success: true;
          data: T;
          metadata?: M;
        }
      | {
          success: false;
          error: ServiceError;
        };

export interface ServiceError {
  message: string;
  code: string;
  details?: Record<string, unknown>;
}

/**
 * Helper functions to construct ServiceResult with proper typing.
 * Use these instead of manual object construction to avoid type casts.
 */
export function serviceSuccess<T>(data: T): ServiceResult<T> {
  return { success: true, data } as ServiceResult<T>;
}

export function serviceError<T>(error: ServiceError): ServiceResult<T> {
  return { success: false, error } as ServiceResult<T>;
}

// File operation types
export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modified: Date;
  created: Date;
}

export interface FileMetadata {
  encoding: 'utf-8' | 'base64';
  isBinary: boolean;
  mimeType: string;
  size: number;
}

export interface ReadOptions {
  encoding?: string;
}

export interface WriteOptions {
  encoding?: string;
  mode?: string;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: string;
}
