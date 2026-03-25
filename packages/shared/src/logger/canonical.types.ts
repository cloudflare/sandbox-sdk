export interface CanonicalEventPayload {
  event: string;
  outcome: 'success' | 'error';
  durationMs: number;

  command?: string;
  path?: string;
  sessionId?: string;
  port?: number;
  repoUrl?: string;
  branch?: string;
  pid?: number;
  exitCode?: number;
  sizeBytes?: number;
  errorMessage?: string;
  sdkVersion?: string;
  containerVersion?: string;
  error?: Error;

  [key: string]: unknown;
}
