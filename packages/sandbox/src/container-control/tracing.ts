/**
 * Thin tracing helper for the RPC control path.
 *
 * Wraps `cloudflare:workers` `tracing.enterSpan` so the connection/client code
 * can emit spans for RPC calls, the connect/disconnect lifecycle, and
 * individual upgrade attempts — without hard-failing in environments where the
 * tracing API is unavailable.
 *
 * Error convention: the Cloudflare trace UI surfaces `error` and `error.stack`
 * span attributes specially (this differs from the OpenTelemetry standard,
 * which uses exception events). We therefore stamp both attributes on the span
 * when the wrapped work throws, so failures are visible in the GUI.
 *
 * Cause chain: the base `@cloudflare/containers` class wraps the true failure
 * inside `new Error(NO_CONTAINER_INSTANCE_ERROR, { cause })`, so the real
 * reason (e.g. "the container is not listening", "Network connection lost", a
 * non-zero exit code) is only visible on `.cause`. Every distinct failure mode
 * therefore collapses to the same generic top-level message in traces. We walk
 * the cause chain and stamp it so a trace names the actual root cause.
 */

import { tracing } from 'cloudflare:workers';

/** Minimal shape of the span object passed to `enterSpan` callbacks. */
export interface TraceSpan {
  setAttribute(key: string, value?: boolean | number | string): void;
}

type SpanAttributes = Record<string, boolean | number | string | undefined>;

/** Bound on cause-chain traversal — guards against cycles and runaway depth. */
const MAX_CAUSE_DEPTH = 8;

/** Read a string `code` property off an arbitrary value, if present. */
function stringCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Render any thrown value as a short human-readable message. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Compute the Cloudflare-convention error span attributes for any thrown value,
 * including the wrapped `.cause` chain. Pure and side-effect-free so it can be
 * unit-tested without a live tracer.
 *
 * Emits:
 *   - `error`            — top-level message (or stringified non-Error)
 *   - `error.stack`      — top-level stack, when available
 *   - `error.code`       — top-level string `code`, when available
 *   - `error.cause`      — immediate cause message, when a cause exists
 *   - `error.cause.code` — immediate cause string `code`, when available
 *   - `error.cause_chain`— all nested cause messages joined by " <- "
 */
export function computeErrorAttributes(error: unknown): SpanAttributes {
  const attrs: SpanAttributes = {};

  if (error instanceof Error) {
    attrs.error = error.message;
    if (typeof error.stack === 'string') attrs['error.stack'] = error.stack;
    const code = stringCode(error);
    if (code !== undefined) attrs['error.code'] = code;
  } else {
    attrs.error = String(error);
    return attrs;
  }

  // Walk the cause chain, guarding against cycles and runaway depth.
  const chain: string[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as { cause?: unknown }).cause;
  let depth = 0;
  while (current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);

    if (depth === 0) {
      attrs['error.cause'] = messageOf(current);
      const causeCode = stringCode(current);
      if (causeCode !== undefined) attrs['error.cause.code'] = causeCode;
    }
    chain.push(messageOf(current));

    current =
      current instanceof Error
        ? (current as { cause?: unknown }).cause
        : undefined;
    depth++;
  }

  if (chain.length > 0) attrs['error.cause_chain'] = chain.join(' <- ');
  return attrs;
}

/**
 * Stamp the Cloudflare-convention error attributes onto a span. Safe to call
 * with any thrown value.
 */
function setErrorAttributes(span: TraceSpan, error: unknown): void {
  for (const [key, value] of Object.entries(computeErrorAttributes(error))) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}

/**
 * Run `fn` inside a span named `name`, applying `attributes` up front and
 * stamping `error`/`error.stack` if it throws. Re-throws the original error.
 *
 * Falls back to running `fn` directly if the tracing API is unavailable, so a
 * missing tracer never changes behavior.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: TraceSpan) => Promise<T>
): Promise<T> {
  const enter = tracing?.enterSpan?.bind(tracing);
  if (typeof enter !== 'function') {
    return fn({ setAttribute: () => {} });
  }
  return enter(name, async (span: TraceSpan) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      return await fn(span);
    } catch (error) {
      setErrorAttributes(span, error);
      throw error;
    }
  });
}

/**
 * Emit a zero-duration marker span for a lifecycle event (e.g. disconnect).
 * Best-effort: never throws, never changes behavior.
 */
export function traceEvent(name: string, attributes: SpanAttributes): void {
  const enter = tracing?.enterSpan?.bind(tracing);
  if (typeof enter !== 'function') return;
  try {
    enter(name, (span: TraceSpan) => {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) span.setAttribute(key, value);
      }
    });
  } catch {
    // Tracing must never break the control path.
  }
}
