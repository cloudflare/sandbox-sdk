import type { CanonicalEventPayload } from './canonical.types.js';
import { redactCommand, truncateForLog } from './sanitize.js';
import type { Logger } from './types.js';

/** Events that are low-value at info on success */
const DEBUG_ON_SUCCESS = new Set([
  'session.create',
  'session.destroy',
  'file.read',
  'file.write',
  'file.delete',
  'file.mkdir'
]);

export interface LogLevelOptions {
  /** Override success level for events with special severity needs.
   *  Cannot demote error outcomes — errors always stay at error. */
  successLevel?: 'debug' | 'info' | 'warn';
}

export function resolveLogLevel(
  payload: CanonicalEventPayload,
  options?: LogLevelOptions
): 'debug' | 'info' | 'warn' | 'error' {
  if (payload.outcome === 'error') return 'error';
  if (options?.successLevel) return options.successLevel;
  if (payload.origin === 'internal') return 'debug';
  if (DEBUG_ON_SUCCESS.has(payload.event)) return 'debug';
  return 'info';
}

/**
 * Sanitize an Error object by redacting sensitive data from message and stack.
 * Produces a copy so the caller's original Error is not mutated.
 */
function sanitizeError(error: Error | undefined): Error | undefined {
  if (!error) return undefined;
  const sanitized = new Error(redactCommand(error.message));
  sanitized.name = error.name;
  sanitized.stack = error.stack ? redactCommand(error.stack) : undefined;
  return sanitized;
}

/**
 * Sanitize and prepare payload fields for both message building and context emission.
 * Called once by logCanonicalEvent to avoid double-redaction.
 */
function sanitizePayload(payload: CanonicalEventPayload): {
  sanitizedCommand?: string;
  commandTruncated: boolean;
} {
  if (payload.command === undefined) {
    return { commandTruncated: false };
  }
  const redacted = redactCommand(payload.command);
  const { value, truncated } = truncateForLog(redacted);
  return { sanitizedCommand: value, commandTruncated: truncated };
}

/**
 * Build a human-readable canonical event message for dashboards and log viewers.
 *
 * Format: `{event} {outcome} {key_context} [— {reason}] ({durationMs}ms[, {sizeBytes}B])`
 *
 * The if/else chain for key context has implicit priority: command > path >
 * sessionId > port > repoUrl > pid. If a payload has multiple, only the
 * highest-priority one appears in the message. All fields are still present
 * as discrete queryable keys in the structured log context.
 */
export function buildMessage(
  payload: CanonicalEventPayload,
  sanitizedCommand?: string
): string {
  const { event } = payload;

  // version.check has its own format: no outcome, no duration
  if (event === 'version.check') {
    const parts: string[] = ['version.check'];
    if (payload.sdkVersion) parts.push(`sdk=${payload.sdkVersion}`);
    if (payload.containerVersion)
      parts.push(`container=${payload.containerVersion}`);
    if (payload.versionOutcome && payload.versionOutcome !== 'compatible') {
      parts.push(`(${payload.versionOutcome})`);
    }
    return parts.join(' ');
  }

  const parts: string[] = [event, payload.outcome];

  // Key context — highest priority field shown in message
  if (sanitizedCommand !== undefined) {
    parts.push(sanitizedCommand);
  } else if (payload.command !== undefined) {
    // Fallback for direct buildMessage calls without pre-sanitized command
    const redacted = redactCommand(payload.command);
    const { value } = truncateForLog(redacted);
    parts.push(value);
  } else if (payload.path !== undefined) {
    parts.push(payload.path);
  } else if (event.includes('session') && payload.sessionId !== undefined) {
    parts.push(payload.sessionId);
  } else if (payload.port !== undefined) {
    parts.push(String(payload.port));
  } else if (payload.repoUrl !== undefined) {
    let gitContext = payload.repoUrl;
    if (payload.branch !== undefined) {
      gitContext += ` ${payload.branch}`;
    }
    parts.push(gitContext);
  } else if (payload.pid !== undefined) {
    parts.push(String(payload.pid));
  } else if (payload.backupId !== undefined) {
    parts.push(payload.backupId);
  } else if (payload.repoPath !== undefined) {
    let gitContext = payload.repoPath;
    if (payload.branch !== undefined) {
      gitContext += ` branch=${payload.branch}`;
    }
    parts.push(gitContext);
  } else if (payload.mountsProcessed !== undefined) {
    let destroyContext = `${payload.mountsProcessed} mounts`;
    if (payload.mountFailures)
      destroyContext += `, ${payload.mountFailures} failed`;
    parts.push(destroyContext);
  } else if (payload.mountPath !== undefined) {
    parts.push(payload.mountPath);
  }

  // Error reason after em-dash
  if (payload.outcome === 'error') {
    if (payload.errorMessage !== undefined) {
      parts.push(`\u2014 ${payload.errorMessage}`);
    } else if (payload.exitCode !== undefined) {
      parts.push(`\u2014 exitCode=${payload.exitCode}`);
    }
  }

  // Duration suffix (and optional size)
  const durationSuffix =
    payload.sizeBytes !== undefined
      ? `(${payload.durationMs}ms, ${payload.sizeBytes}B)`
      : `(${payload.durationMs}ms)`;
  parts.push(durationSuffix);

  return parts.join(' ');
}

/**
 * Log a canonical event — the single entry point for all structured operational events.
 *
 * Sanitizes command fields once, builds the message, selects log level from
 * outcome, and emits a structured log entry with the full payload as context.
 */
export function logCanonicalEvent(
  logger: Logger,
  payload: CanonicalEventPayload,
  options?: LogLevelOptions
): void {
  // Auto-derive errorMessage from error.message when not explicitly set,
  // then sanitize to prevent credential leaks (e.g., presigned URLs in error strings)
  const resolvedErrorMessage = payload.errorMessage ?? payload.error?.message;
  const sanitizedErrorMessage = resolvedErrorMessage
    ? redactCommand(resolvedErrorMessage)
    : undefined;
  const enrichedPayload =
    sanitizedErrorMessage !== undefined
      ? { ...payload, errorMessage: sanitizedErrorMessage }
      : payload;

  // Sanitize once, use for both message and context
  const { sanitizedCommand, commandTruncated } =
    sanitizePayload(enrichedPayload);

  const message = buildMessage(enrichedPayload, sanitizedCommand);

  // Build context from enriched payload, excluding the error object (passed separately)
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(enrichedPayload)) {
    if (key === 'error') continue;
    context[key] = value;
  }

  // Apply sanitized command to context
  if (sanitizedCommand !== undefined) {
    context.command = sanitizedCommand;
    if (commandTruncated) {
      context.commandTruncated = true;
    }
  }

  const level = resolveLogLevel(enrichedPayload, options);
  if (level === 'error') {
    logger.error(message, sanitizeError(payload.error), context);
  } else if (level === 'warn') {
    logger.warn(message, context);
  } else if (level === 'debug') {
    logger.debug(message, context);
  } else {
    logger.info(message, context);
  }
}
