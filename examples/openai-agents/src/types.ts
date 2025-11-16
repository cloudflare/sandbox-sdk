// Command result for API responses
export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: number;
}

// File operation result for API responses
export interface FileOperationResult {
  operation: 'create' | 'update' | 'delete';
  path: string;
  status: 'completed' | 'failed';
  output: string;
  error?: string;
  timestamp: number;
}
