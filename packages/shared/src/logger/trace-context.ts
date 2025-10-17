/**
 * Trace context utilities for request correlation
 *
 * Trace IDs enable correlating logs across distributed components:
 * Worker → Durable Object → Container → back
 *
 * The trace ID is propagated via the X-Trace-Id HTTP header.
 */

/**
 * Utility for managing trace context across distributed components
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Keep as class for namespace grouping and discoverability
export class TraceContext {
  /**
   * HTTP header name for trace ID propagation
   */
  private static readonly TRACE_HEADER = 'X-Trace-Id';

  /**
   * Generate a new trace ID
   *
   * Format: "tr_" + 16 random hex characters
   * Example: "tr_7f3a9b2c4e5d6f1a"
   *
   * @returns Newly generated trace ID
   */
  static generate(): string {
    // Use crypto.randomUUID() for randomness, extract 16 hex chars
    const randomHex = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    return `tr_${randomHex}`;
  }

  /**
   * Extract trace ID from HTTP request headers
   *
   * @param headers Request headers
   * @returns Trace ID if present, null otherwise
   */
  static fromHeaders(headers: Headers): string | null {
    return headers.get(TraceContext.TRACE_HEADER);
  }

  /**
   * Create headers object with trace ID for outgoing requests
   *
   * @param traceId Trace ID to include
   * @returns Headers object with X-Trace-Id set
   */
  static toHeaders(traceId: string): Record<string, string> {
    return { [TraceContext.TRACE_HEADER]: traceId };
  }

  /**
   * Get the header name used for trace ID propagation
   *
   * @returns Header name ("X-Trace-Id")
   */
  static getHeaderName(): string {
    return TraceContext.TRACE_HEADER;
  }
}
