/**
 * Error classes for the Cloudflare Sandbox SDK
 * These are internal errors thrown by the SDK implementation
 */

export class SandboxError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class ProcessNotFoundError extends SandboxError {
  constructor(processId: string) {
    super(`Process not found: ${processId}`, 'PROCESS_NOT_FOUND');
    this.name = 'ProcessNotFoundError';
  }
}