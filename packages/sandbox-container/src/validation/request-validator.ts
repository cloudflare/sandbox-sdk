// Request Validator - Structure validation only
//
// Philosophy:
// - Use Zod for HTTP request structure validation (untrusted external input)
// - NO security validation here - services handle their own validation
// - Keep it simple - just parse and return typed data
import type { StartProcessRequest } from '@repo/shared';
import type { ValidationResult } from '../core/types';
import {
  type ExecuteRequest,
  ExecuteRequestSchema,
  type ExposePortRequest,
  ExposePortRequestSchema,
  type FileOperation,
  type FileRequest,
  FileRequestSchemas,
  type GitCheckoutRequest,
  GitCheckoutRequestSchema,
  StartProcessRequestSchema,
} from './schemas';

export class RequestValidator {
  // No security service dependency needed!
  // Services handle their own validation

  validateExecuteRequest(request: unknown): ValidationResult<ExecuteRequest> {
    // Parse with Zod - structure validation only
    const parseResult = ExecuteRequestSchema.safeParse(request);

    if (!parseResult.success) {
      return {
        isValid: false,
        errors: parseResult.error.issues.map(issue => ({
          field: issue.path.join('.') || 'request',
          message: issue.message,
          code: issue.code,
        })),
      };
    }

    // Return parsed data - services will handle validation
    return {
      isValid: true,
      data: parseResult.data,
      errors: [],
    };
  }

  validateFileRequest<T extends FileRequest>(request: unknown, operation: FileOperation): ValidationResult<T> {
    // Get the appropriate schema for the operation
    const schema = FileRequestSchemas[operation];
    const parseResult = schema.safeParse(request);

    if (!parseResult.success) {
      return {
        isValid: false,
        errors: parseResult.error.issues.map(issue => ({
          field: issue.path.join('.') || 'request',
          message: issue.message,
          code: issue.code,
        })),
      };
    }

    // Return parsed data - services will handle validation
    return {
      isValid: true,
      data: parseResult.data as T,
      errors: [],
    };
  }

  validateProcessRequest(request: unknown): ValidationResult<StartProcessRequest> {
    const parseResult = StartProcessRequestSchema.safeParse(request);

    if (!parseResult.success) {
      return {
        isValid: false,
        errors: parseResult.error.issues.map(issue => ({
          field: issue.path.join('.') || 'request',
          message: issue.message,
          code: issue.code,
        })),
      };
    }

    // Return parsed data - services will handle validation
    return {
      isValid: true,
      data: parseResult.data,
      errors: [],
    };
  }

  validatePortRequest(request: unknown): ValidationResult<ExposePortRequest> {
    const parseResult = ExposePortRequestSchema.safeParse(request);

    if (!parseResult.success) {
      return {
        isValid: false,
        errors: parseResult.error.issues.map(issue => ({
          field: issue.path.join('.') || 'request',
          message: issue.message,
          code: issue.code,
        })),
      };
    }

    // Return parsed data - services will handle validation
    return {
      isValid: true,
      data: parseResult.data,
      errors: [],
    };
  }

  validateGitRequest(request: unknown): ValidationResult<GitCheckoutRequest> {
    const parseResult = GitCheckoutRequestSchema.safeParse(request);

    if (!parseResult.success) {
      return {
        isValid: false,
        errors: parseResult.error.issues.map(issue => ({
          field: issue.path.join('.') || 'request',
          message: issue.message,
          code: issue.code,
        })),
      };
    }

    // Return parsed data - services will handle validation
    return {
      isValid: true,
      data: parseResult.data,
      errors: [],
    };
  }
}
