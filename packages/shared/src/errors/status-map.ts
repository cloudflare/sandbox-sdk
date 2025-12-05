import { ErrorCode } from './codes';

/**
 * Maps error codes to HTTP status codes
 * Centralized mapping ensures consistency across SDK
 */
export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  // 404 Not Found
  [ErrorCode.FILE_NOT_FOUND]: 404,
  [ErrorCode.COMMAND_NOT_FOUND]: 404,
  [ErrorCode.PROCESS_NOT_FOUND]: 404,
  [ErrorCode.PORT_NOT_EXPOSED]: 404,
  [ErrorCode.GIT_REPOSITORY_NOT_FOUND]: 404,
  [ErrorCode.GIT_BRANCH_NOT_FOUND]: 404,
  [ErrorCode.CONTEXT_NOT_FOUND]: 404,

  // 400 Bad Request
  [ErrorCode.IS_DIRECTORY]: 400,
  [ErrorCode.NOT_DIRECTORY]: 400,
  [ErrorCode.INVALID_COMMAND]: 400,
  [ErrorCode.INVALID_PORT_NUMBER]: 400,
  [ErrorCode.INVALID_PORT]: 400,
  [ErrorCode.INVALID_GIT_URL]: 400,
  [ErrorCode.CUSTOM_DOMAIN_REQUIRED]: 400,
  [ErrorCode.INVALID_JSON_RESPONSE]: 400,
  [ErrorCode.NAME_TOO_LONG]: 400,
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.MISSING_CREDENTIALS]: 400,
  [ErrorCode.INVALID_MOUNT_CONFIG]: 400,

  // 401 Unauthorized
  [ErrorCode.GIT_AUTH_FAILED]: 401,

  // 403 Forbidden
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.COMMAND_PERMISSION_DENIED]: 403,
  [ErrorCode.PROCESS_PERMISSION_DENIED]: 403,
  [ErrorCode.READ_ONLY]: 403,

  // 409 Conflict
  [ErrorCode.FILE_EXISTS]: 409,
  [ErrorCode.PORT_ALREADY_EXPOSED]: 409,
  [ErrorCode.PORT_IN_USE]: 409,
  [ErrorCode.RESOURCE_BUSY]: 409,

  // 502 Bad Gateway
  [ErrorCode.SERVICE_NOT_RESPONDING]: 502,
  [ErrorCode.GIT_NETWORK_ERROR]: 502,

  // 501 Not Implemented (feature not available in image variant)
  [ErrorCode.PYTHON_NOT_AVAILABLE]: 501,
  [ErrorCode.JAVASCRIPT_NOT_AVAILABLE]: 501,

  // 503 Service Unavailable
  [ErrorCode.INTERPRETER_NOT_READY]: 503,

  // 500 Internal Server Error
  [ErrorCode.NO_SPACE]: 500,
  [ErrorCode.TOO_MANY_FILES]: 500,
  [ErrorCode.TOO_MANY_LINKS]: 500,
  [ErrorCode.FILESYSTEM_ERROR]: 500,
  [ErrorCode.COMMAND_EXECUTION_ERROR]: 500,
  [ErrorCode.STREAM_START_ERROR]: 500,
  [ErrorCode.PROCESS_ERROR]: 500,
  [ErrorCode.PORT_OPERATION_ERROR]: 500,
  [ErrorCode.GIT_CLONE_FAILED]: 500,
  [ErrorCode.GIT_CHECKOUT_FAILED]: 500,
  [ErrorCode.GIT_OPERATION_FAILED]: 500,
  [ErrorCode.CODE_EXECUTION_ERROR]: 500,
  [ErrorCode.BUCKET_MOUNT_ERROR]: 500,
  [ErrorCode.S3FS_MOUNT_ERROR]: 500,
  [ErrorCode.UNKNOWN_ERROR]: 500,
  [ErrorCode.INTERNAL_ERROR]: 500
};

/**
 * Get HTTP status code for an error code
 * Falls back to 500 for unknown errors
 */
export function getHttpStatus(code: ErrorCode): number {
  return ERROR_STATUS_MAP[code] || 500;
}
