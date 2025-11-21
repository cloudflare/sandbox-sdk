/**
 * Type definitions for test worker endpoints
 *
 * These types define responses from test worker endpoints that wrap SDK functionality
 * or provide test-specific features (health checks, R2 operations, WebSocket init).
 *
 * For SDK operations (exec, file ops, process management), the test worker passes through
 * SDK types directly (ExecResult, ProcessStartResult, etc.) - those should be imported
 * from @repo/shared in test files.
 */

// Health check endpoint
export interface HealthResponse {
  status: string;
}

// Session management wrapper responses
export interface SessionCreateResponse {
  success: boolean;
  sessionId: string;
}

// Simple success responses (used by multiple endpoints)
export interface SuccessResponse {
  success: boolean;
}

export interface SuccessWithMessageResponse {
  success: boolean;
  message: string;
}

// R2 bucket operations
export interface BucketPutResponse {
  success: boolean;
  key: string;
}

export interface BucketGetResponse {
  success: boolean;
  key: string;
  content: string;
  contentType?: string;
  size: number;
}

export interface BucketDeleteResponse {
  success: boolean;
  key: string;
}

// Port unexpose response
export interface PortUnexposeResponse {
  success: boolean;
  port: number;
}

// Code context delete response
export interface CodeContextDeleteResponse {
  success: boolean;
  contextId: string;
}

// WebSocket init response
export interface WebSocketInitResponse {
  success: boolean;
  serversStarted: number;
  serversFailed: number;
  errors?: string[];
}

// Error responses
export interface ErrorResponse {
  error: string;
}
