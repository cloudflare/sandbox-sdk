const SUPERSEDED_ISOLATE_PATTERN =
  /reset because its code was updated|this script has been upgraded/i;
const CONNECTION_LOST_PATTERN = /network connection lost/i;
const DO_STORAGE_STARTUP_RESET_PATTERN =
  /internal error while starting up durable object storage caused object to be reset/i;

function errorMessageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
}

/**
 * Extract a matchable message from any thrown value, reading a `.message`
 * property even when the value is not an `Error` instance. The Containers
 * runtime raises admission failures from the container binding, which may
 * live in a different realm — so `instanceof Error` can be false for a
 * genuine error. Mirrors the base `@cloudflare/containers` `isErrorOfType`
 * helper: coerce to a string, then match case-insensitively.
 */
function realmSafeMessageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : String(error);
}

/**
 * Categorical reason the Containers platform could not admit an instance for
 * a Durable Object during startup. A subset of `ContainerUnavailableReason`
 * covering the two failures the platform signals by *throwing* (rather than
 * returning a structured body).
 */
export type PlatformUnavailableReason =
  | 'no_container_instance_available'
  | 'max_container_instances_exceeded';

/**
 * Platform messages emitted by the Containers runtime when it cannot admit a
 * container for a Durable Object during startup. Matched case-insensitively as
 * lowercase substrings. Single source of truth for both the RPC connection
 * path (connection.ts) and the HTTP `containerFetch` path (sandbox.ts).
 */
const CONTAINER_UNAVAILABLE_SIGNATURES: ReadonlyArray<{
  substring: string;
  reason: PlatformUnavailableReason;
}> = [
  {
    // Platform error thrown from the container binding during startup.
    substring:
      'there is no container instance that can be provided to this durable object',
    reason: 'no_container_instance_available'
  },
  {
    // Plain-text 503 body returned by @cloudflare/containers' containerFetch
    // when no instance can be admitted (see container.ts).
    substring: 'there is no container instance available at this time',
    reason: 'no_container_instance_available'
  },
  {
    substring: 'maximum number of running container instances exceeded',
    reason: 'max_container_instances_exceeded'
  }
];

/**
 * Classify a container-startup error as a platform admission/capacity failure,
 * returning the categorical reason or null. Realm-safe (does not gate on
 * `instanceof Error`), case-insensitive, and walks the `.cause` chain so a
 * wrapped admission failure is still recognized.
 */
export function matchContainerUnavailable(
  error: unknown
): PlatformUnavailableReason | null {
  for (const candidate of selfAndCauses(error)) {
    const text = realmSafeMessageOf(candidate).toLowerCase();
    const match = CONTAINER_UNAVAILABLE_SIGNATURES.find((sig) =>
      text.includes(sig.substring)
    );
    if (match) return match.reason;
  }
  return null;
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
    if (DO_STORAGE_STARTUP_RESET_PATTERN.test(message)) return true;
    if (isErrorRetryable(candidate)) return true;
  }
  return false;
}
