import type { CanonicalEventPayload } from './canonical.types.js';
import { redactCommand, truncateForLog } from './sanitize.js';
import type { Logger } from './types.js';

/**
 * Build a human-readable canonical event message for dashboards and log viewers.
 *
 * Format: `{event} {outcome} {key_context} [— {reason}] ({durationMs}ms[, {sizeBytes}B])`
 */
export function buildMessage(payload: CanonicalEventPayload): string {
  const { event } = payload;

  // Special case: version.check has no outcome or duration
  if (event === 'version.check') {
    return `version.check sdk=${payload.sdkVersion} container=${payload.containerVersion}`;
  }

  const parts: string[] = [event, payload.outcome];

  // Key context based on event type
  if (payload.command !== undefined) {
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
 * Sanitizes command fields, selects log level from outcome, and emits
 * a structured log entry with the full payload as context.
 */
export function logCanonicalEvent(
  logger: Logger,
  payload: CanonicalEventPayload
): void {
  const message = buildMessage(payload);

  // Build context from payload, excluding the error object (passed separately)
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'error') continue;
    context[key] = value;
  }

  // Sanitize command in context
  if (payload.command !== undefined) {
    const redacted = redactCommand(payload.command);
    const { value, truncated } = truncateForLog(redacted);
    context.command = value;
    if (truncated) {
      context.commandTruncated = true;
    }
  }

  if (payload.outcome === 'error') {
    logger.error(message, payload.error, context);
  } else {
    logger.info(message, context);
  }
}
