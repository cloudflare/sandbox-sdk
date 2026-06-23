const SUPERSEDED_ISOLATE_PATTERN =
  /reset because its code was updated|this script has been upgraded/i;
const CONNECTION_LOST_PATTERN = /network connection lost/i;

function errorMessageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
}

function* selfAndCauses(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    yield current;
    current =
      typeof current === 'object'
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
}

function isErrorRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = String(error);
  const typed = error as { retryable?: boolean; overloaded?: boolean };
  return (
    typed.retryable === true &&
    typed.overloaded !== true &&
    !message.includes('Durable Object is overloaded')
  );
}

/**
 * Whether an error was raised because the current Durable Object isolate was
 * superseded by a deploy/code update. In-process retries are futile for this
 * class because the invocation keeps running on the old isolate; callers
 * should return control to the platform or retry from a fresh request.
 */
export function isDurableObjectCodeUpdateReset(error: unknown): boolean {
  for (const candidate of selfAndCauses(error)) {
    if (SUPERSEDED_ISOLATE_PATTERN.test(errorMessageOf(candidate))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether an error represents a transient platform lifecycle/storage failure,
 * not an application-level sandbox failure.
 */
export function isPlatformTransientError(error: unknown): boolean {
  for (const candidate of selfAndCauses(error)) {
    const message = errorMessageOf(candidate);
    if (SUPERSEDED_ISOLATE_PATTERN.test(message)) return true;
    if (CONNECTION_LOST_PATTERN.test(message)) return true;
    if (isErrorRetryable(candidate)) return true;
  }
  return false;
}
