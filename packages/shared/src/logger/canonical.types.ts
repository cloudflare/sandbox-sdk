/**
 * Payload for a canonical log event.
 *
 * Required fields (event, outcome, durationMs) are enforced by TypeScript.
 * Common optional fields are typed for autocomplete and typo detection.
 * The index signature allows event-specific fields (e.g., labelerTimeout,
 * mountResults) without requiring them in the shared interface.
 *
 * Command text and process output are caller data that can carry secrets in
 * arguments, headers, or environment assignments, so they are typed `never`
 * and cannot be logged. Describe executions with IDs, exit codes, and output
 * lengths instead.
 */
export interface CanonicalEventPayload {
  /** domain.operation name (e.g., "sandbox.exec", "command.exec") */
  event: string;
  /** Whether this event was user-initiated or internal infrastructure */
  origin?: 'user' | 'internal';
  /** Result of the operation */
  outcome: 'success' | 'error';
  /** Wall-clock duration in milliseconds */
  durationMs: number;

  // Common fields used across multiple event types
  command?: never;
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
  versionOutcome?: string;
  error?: Error;

  // Frequently-used domain fields (typed for autocomplete + typo safety)
  commandId?: string;
  processId?: string;
  targetDir?: string;
  cwd?: string;
  stdoutLen?: number;
  stderrLen?: number;
  stderrPreview?: never;
  backupId?: string;
  repoPath?: string;
  mountPath?: string;
  mountsProcessed?: number;
  mountFailures?: number;
  recursive?: boolean;
  name?: string;

  /** Event-specific fields not worth typing in the shared interface */
  [key: string]: unknown;
}
