// Request Validation Service
import type { 
  ValidationResult, 
  ExecuteRequest,
  ReadFileRequest,
  WriteFileRequest,
  DeleteFileRequest,
  RenameFileRequest,
  MoveFileRequest,
  MkdirRequest,
  ExposePortRequest,
  StartProcessRequest,
  GitCheckoutRequest,
} from '../core/types';

import type { SecurityService } from '../security/security-service';

// Schema definitions for type checking
type Schema = {
  type: 'object';
  required: string[];
  properties: Record<string, { type: string; minLength?: number; optional?: boolean }>;
};

export class RequestValidator {
  constructor(private security: SecurityService) {}

  validateExecuteRequest(request: unknown): ValidationResult<ExecuteRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', minLength: 1 },
        sessionId: { type: 'string', optional: true },
        background: { type: 'boolean', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as ExecuteRequest;
    
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
      data: {
        command: commandValidation.data as string,
        sessionId: typedRequest.sessionId,
        background: typedRequest.background,
      },
      errors: [],
    };
  }

  validateFileRequest(request: unknown, operation: 'read' | 'write' | 'delete' | 'rename' | 'move' | 'mkdir'): ValidationResult {
    switch (operation) {
      case 'read':
        return this.validateReadFileRequest(request);
      case 'write':
        return this.validateWriteFileRequest(request);
      case 'delete':
        return this.validateDeleteFileRequest(request);
      case 'rename':
        return this.validateRenameFileRequest(request);
      case 'move':
        return this.validateMoveFileRequest(request);
      case 'mkdir':
        return this.validateMkdirRequest(request);
      default:
        return {
          isValid: false,
          errors: [{ field: 'operation', message: 'Invalid file operation', code: 'INVALID_OPERATION' }],
        };
    }
  }

  validateReadFileRequest(request: unknown): ValidationResult<ReadFileRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
        encoding: { type: 'string', optional: true },
        sessionId: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as ReadFileRequest;
    
    // Path security validation
    const pathValidation = this.security.validatePath(typedRequest.path);
    if (!pathValidation.isValid) {
      return {
        isValid: false,
        errors: pathValidation.errors,
      };
    }

    return {
      isValid: true,
      data: {
        path: pathValidation.data as string,
        encoding: typedRequest.encoding,
        sessionId: typedRequest.sessionId,
      },
      errors: [],
    };
  }

  validateWriteFileRequest(request: unknown): ValidationResult<WriteFileRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        encoding: { type: 'string', optional: true },
        sessionId: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as WriteFileRequest;
    
    // Path security validation
    const pathValidation = this.security.validatePath(typedRequest.path);
    if (!pathValidation.isValid) {
      return {
        isValid: false,
        errors: pathValidation.errors,
      };
    }

    // Content size validation
    if (typedRequest.content.length > 10 * 1024 * 1024) { // 10MB limit
      return {
        isValid: false,
        errors: [{ field: 'content', message: 'File content too large (max 10MB)', code: 'CONTENT_TOO_LARGE' }],
      };
    }

    return {
      isValid: true,
      data: {
        path: pathValidation.data as string,
        content: typedRequest.content,
        encoding: typedRequest.encoding,
        sessionId: typedRequest.sessionId,
      },
      errors: [],
    };
  }

  validateDeleteFileRequest(request: unknown): ValidationResult<DeleteFileRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
        sessionId: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as DeleteFileRequest;
    
    // Path security validation
    const pathValidation = this.security.validatePath(typedRequest.path);
    if (!pathValidation.isValid) {
      return {
        isValid: false,
        errors: pathValidation.errors,
      };
    }

    return {
      isValid: true,
      data: {
        path: pathValidation.data as string,
        sessionId: typedRequest.sessionId,
      },
      errors: [],
    };
  }

  validateRenameFileRequest(request: unknown): ValidationResult<RenameFileRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['oldPath', 'newPath'],
      properties: {
        oldPath: { type: 'string', minLength: 1 },
        newPath: { type: 'string', minLength: 1 },
        sessionId: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as RenameFileRequest;
    
    // Path security validation for both paths
    const oldPathValidation = this.security.validatePath(typedRequest.oldPath);
    if (!oldPathValidation.isValid) {
      return {
        isValid: false,
        errors: oldPathValidation.errors.map(e => ({ ...e, field: 'oldPath' })),
      };
    }

    const newPathValidation = this.security.validatePath(typedRequest.newPath);
    if (!newPathValidation.isValid) {
      return {
        isValid: false,
        errors: newPathValidation.errors.map(e => ({ ...e, field: 'newPath' })),
      };
    }

    return {
      isValid: true,
      data: {
        oldPath: oldPathValidation.data as string,
        newPath: newPathValidation.data as string,
        sessionId: typedRequest.sessionId,
      },
      errors: [],
    };
  }

  validateMoveFileRequest(request: unknown): ValidationResult<MoveFileRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['sourcePath', 'destinationPath'],
      properties: {
        sourcePath: { type: 'string', minLength: 1 },
        destinationPath: { type: 'string', minLength: 1 },
        sessionId: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as MoveFileRequest;
    
    // Path security validation for both paths
    const sourcePathValidation = this.security.validatePath(typedRequest.sourcePath);
    if (!sourcePathValidation.isValid) {
      return {
        isValid: false,
        errors: sourcePathValidation.errors.map(e => ({ ...e, field: 'sourcePath' })),
      };
    }

    const destPathValidation = this.security.validatePath(typedRequest.destinationPath);
    if (!destPathValidation.isValid) {
      return {
        isValid: false,
        errors: destPathValidation.errors.map(e => ({ ...e, field: 'destinationPath' })),
      };
    }

    return {
      isValid: true,
      data: {
        sourcePath: sourcePathValidation.data as string,
        destinationPath: destPathValidation.data as string,
        sessionId: typedRequest.sessionId,
      },
      errors: [],
    };
  }

  validateMkdirRequest(request: unknown): ValidationResult<MkdirRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
        recursive: { type: 'boolean', optional: true },
        sessionId: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as MkdirRequest;
    
    // Path security validation
    const pathValidation = this.security.validatePath(typedRequest.path);
    if (!pathValidation.isValid) {
      return {
        isValid: false,
        errors: pathValidation.errors,
      };
    }

    return {
      isValid: true,
      data: {
        path: pathValidation.data as string,
        recursive: typedRequest.recursive,
        sessionId: typedRequest.sessionId,
      },
      errors: [],
    };
  }

  validateProcessRequest(request: unknown): ValidationResult<StartProcessRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', minLength: 1 },
        options: { type: 'object', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as StartProcessRequest;
    
    // Command security validation
    const commandValidation = this.security.validateCommand(typedRequest.command);
    if (!commandValidation.isValid) {
      return {
        isValid: false,
        errors: commandValidation.errors,
      };
    }

    // Validate options if provided
    if (typedRequest.options) {
      const options = typedRequest.options;
      
      // Validate cwd path if provided
      if (options.cwd) {
        const cwdValidation = this.security.validatePath(options.cwd);
        if (!cwdValidation.isValid) {
          return {
            isValid: false,
            errors: cwdValidation.errors.map(e => ({ ...e, field: 'options.cwd' })),
          };
        }
      }

      // Validate timeout
      if (options.timeout && (typeof options.timeout !== 'number' || options.timeout < 0 || options.timeout > 3600000)) {
        return {
          isValid: false,
          errors: [{ field: 'options.timeout', message: 'Timeout must be between 0 and 3600000ms (1 hour)', code: 'INVALID_TIMEOUT' }],
        };
      }
    }

    return {
      isValid: true,
      data: {
        command: commandValidation.data as string,
        options: typedRequest.options,
      },
      errors: [],
    };
  }

  validatePortRequest(request: unknown): ValidationResult<ExposePortRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['port'],
      properties: {
        port: { type: 'number' },
        name: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as ExposePortRequest;
    
    // Port security validation
    const portValidation = this.security.validatePort(typedRequest.port);
    if (!portValidation.isValid) {
      return {
        isValid: false,
        errors: portValidation.errors,
      };
    }

    // Name validation if provided
    if (typedRequest.name) {
      if (typeof typedRequest.name !== 'string' || typedRequest.name.length > 100) {
        return {
          isValid: false,
          errors: [{ field: 'name', message: 'Port name must be a string with max 100 characters', code: 'INVALID_PORT_NAME' }],
        };
      }
    }

    return {
      isValid: true,
      data: {
        port: portValidation.data as number,
        name: typedRequest.name,
      },
      errors: [],
    };
  }

  validateGitRequest(request: unknown): ValidationResult<GitCheckoutRequest> {
    const schema: Schema = {
      type: 'object',
      required: ['repoUrl'],
      properties: {
        repoUrl: { type: 'string', minLength: 1 },
        branch: { type: 'string', optional: true },
        targetDir: { type: 'string', optional: true },
        sessionId: { type: 'string', optional: true },
      },
    };

    const baseValidation = this.validateRequestBase(request, schema);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const typedRequest = request as GitCheckoutRequest;
    
    // Git URL security validation
    const urlValidation = this.security.validateGitUrl(typedRequest.repoUrl);
    if (!urlValidation.isValid) {
      return {
        isValid: false,
        errors: urlValidation.errors,
      };
    }

    // Target directory validation if provided
    if (typedRequest.targetDir) {
      const pathValidation = this.security.validatePath(typedRequest.targetDir);
      if (!pathValidation.isValid) {
        return {
          isValid: false,
          errors: pathValidation.errors.map(e => ({ ...e, field: 'targetDir' })),
        };
      }
    }

    // Branch name validation if provided
    if (typedRequest.branch) {
      if (typeof typedRequest.branch !== 'string' || 
          typedRequest.branch.length === 0 || 
          typedRequest.branch.length > 255 ||
          /[<>|&;`$(){}[\]]/.test(typedRequest.branch)) {
        return {
          isValid: false,
          errors: [{ field: 'branch', message: 'Invalid branch name', code: 'INVALID_BRANCH_NAME' }],
        };
      }
    }

    return {
      isValid: true,
      data: {
        repoUrl: urlValidation.data as string,
        branch: typedRequest.branch,
        targetDir: typedRequest.targetDir,
        sessionId: typedRequest.sessionId,
      },
      errors: [],
    };
  }

  private validateRequestBase(request: unknown, schema: Schema): ValidationResult {
    const errors: Array<{ field: string; message: string; code: string }> = [];

    // Check if request is an object
    if (!request || typeof request !== 'object') {
      errors.push({ field: 'request', message: 'Request must be an object', code: 'INVALID_REQUEST_TYPE' });
      return { isValid: false, errors };
    }

    const req = request as Record<string, unknown>;

    // Check required fields
    for (const field of schema.required) {
      if (!(field in req) || req[field] === undefined || req[field] === null) {
        errors.push({ field, message: `Field '${field}' is required`, code: 'REQUIRED_FIELD_MISSING' });
      }
    }

    // Check field types
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      if (field in req && req[field] !== undefined && req[field] !== null) {
        const value = req[field];
        
        // Type checking
        if (fieldSchema.type === 'string' && typeof value !== 'string') {
          errors.push({ field, message: `Field '${field}' must be a string`, code: 'INVALID_FIELD_TYPE' });
        } else if (fieldSchema.type === 'number' && typeof value !== 'number') {
          errors.push({ field, message: `Field '${field}' must be a number`, code: 'INVALID_FIELD_TYPE' });
        } else if (fieldSchema.type === 'boolean' && typeof value !== 'boolean') {
          errors.push({ field, message: `Field '${field}' must be a boolean`, code: 'INVALID_FIELD_TYPE' });
        } else if (fieldSchema.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
          errors.push({ field, message: `Field '${field}' must be an object`, code: 'INVALID_FIELD_TYPE' });
        }

        // String length validation
        if (fieldSchema.type === 'string' && typeof value === 'string' && fieldSchema.minLength) {
          if (value.length < fieldSchema.minLength) {
            errors.push({ field, message: `Field '${field}' must be at least ${fieldSchema.minLength} characters`, code: 'FIELD_TOO_SHORT' });
          }
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}