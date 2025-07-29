// Zod-based Request Validator - No more type casting!
import type { ValidationResult } from '../core/types';
import type { SecurityService } from '../core/container';
import {
  ExecuteRequestSchema,
  ReadFileRequestSchema,
  WriteFileRequestSchema,
  DeleteFileRequestSchema,
  RenameFileRequestSchema,
  MoveFileRequestSchema,
  MkdirRequestSchema,
  StartProcessRequestSchema,
  ExposePortRequestSchema,
  GitCheckoutRequestSchema,
  FileRequestSchemas,
  type ExecuteRequest,
  type FileRequest,
  type StartProcessRequest,
  type ExposePortRequest,
  type GitCheckoutRequest,
  type FileOperation,
} from './schemas';

export class RequestValidator {
  constructor(private security: SecurityService) {}

  validateExecuteRequest(request: unknown): ValidationResult<ExecuteRequest> {
    // Parse with Zod - no casting needed!
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

    // parseResult.data is automatically typed as ExecuteRequest
    const typedRequest = parseResult.data;
    
    // Additional security validation for command
    const commandValidation = this.security.validateCommand(typedRequest.command);
    if (!commandValidation.isValid) {
      return {
        isValid: false,
        errors: commandValidation.errors,
      };
    }

    return {
      isValid: true,
      data: typedRequest,
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

    // parseResult.data is automatically typed correctly
    const typedRequest = parseResult.data;
    
    // Additional security validation for path(s)
    const pathsToValidate: string[] = [];
    
    if ('path' in typedRequest) {
      pathsToValidate.push(typedRequest.path);
    }
    if ('oldPath' in typedRequest) {
      pathsToValidate.push(typedRequest.oldPath);
    }
    if ('newPath' in typedRequest) {
      pathsToValidate.push(typedRequest.newPath);
    }
    if ('sourcePath' in typedRequest) {
      pathsToValidate.push(typedRequest.sourcePath);
    }
    if ('destinationPath' in typedRequest) {
      pathsToValidate.push(typedRequest.destinationPath);
    }

    for (const path of pathsToValidate) {
      const pathValidation = this.security.validatePath(path);
      if (!pathValidation.isValid) {
        return {
          isValid: false,
          errors: pathValidation.errors,
        };
      }
    }

    return {
      isValid: true,
      data: typedRequest as T, // Safe cast since we validated with the correct schema for this operation
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

    const typedRequest = parseResult.data;
    
    // Additional security validation for command
    const commandValidation = this.security.validateCommand(typedRequest.command);
    if (!commandValidation.isValid) {
      return {
        isValid: false,
        errors: commandValidation.errors,
      };
    }

    return {
      isValid: true,
      data: typedRequest,
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

    const typedRequest = parseResult.data;
    
    // Additional security validation for port
    const portValidation = this.security.validatePort(typedRequest.port);
    if (!portValidation.isValid) {
      return {
        isValid: false,
        errors: portValidation.errors,
      };
    }

    return {
      isValid: true,
      data: typedRequest,
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

    const typedRequest = parseResult.data;
    
    // Additional security validation for Git URL
    const gitUrlValidation = this.security.validateGitUrl(typedRequest.repoUrl);
    if (!gitUrlValidation.isValid) {
      return {
        isValid: false,
        errors: gitUrlValidation.errors,
      };
    }

    // If targetDir is provided, validate it as a path
    if (typedRequest.targetDir) {
      const pathValidation = this.security.validatePath(typedRequest.targetDir);
      if (!pathValidation.isValid) {
        return {
          isValid: false,
          errors: pathValidation.errors,
        };
      }
    }

    return {
      isValid: true,
      data: typedRequest,
      errors: [],
    };
  }
}