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
 */

import { tracing } from 'cloudflare:workers';

/** Minimal shape of the span object passed to `enterSpan` callbacks. */
export interface TraceSpan {
  setAttribute(key: string, value?: boolean | number | string): void;
}

type SpanAttributes = Record<string, boolean | number | string | undefined>;

/**
 * Stamp the Cloudflare-convention error attributes onto a span. Safe to call
 * with any thrown value.
 */
function setErrorAttributes(span: TraceSpan, error: unknown): void {
  if (error instanceof Error) {
    span.setAttribute('error', error.message);
    if (typeof error.stack === 'string') {
      span.setAttribute('error.stack', error.stack);
    }
    // A code (e.g. SandboxError.code) is high-signal for filtering.
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') span.setAttribute('error.code', code);
    return;
  }
  span.setAttribute('error', String(error));
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
