/**
 * Request to validate TypeScript schema with test data
 */
export interface ValidateRequest {
  schemaCode: string;
  testData: unknown;
}

/**
 * Response from validation
 */
export interface ValidateResponse {
  sessionId: string;
  compiled: boolean;
  timings: {
    bundle?: number;
    load: number;
    execute: number;
  };
  result: {
    success: boolean;
    data?: unknown;
    error?: {
      issues: unknown[];
    };
  };
}

/**
 * Error response
 */
export interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * Status line for UI display
 */
export interface StatusLine {
  text: string;
  className:
    | 'status-success'
    | 'status-error'
    | 'status-info'
    | 'status-neutral';
}
