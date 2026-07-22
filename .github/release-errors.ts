export class OperationalReleaseError extends Error {
  constructor(
    readonly phase: string,
    readonly domain: string,
    message: string,
    readonly originalError?: unknown
  ) {
    super(`${phase} ${domain} failed: ${message}`);
    this.name = 'OperationalReleaseError';
  }
}

export class ValidationReleaseError extends Error {
  constructor(
    readonly phase: string,
    readonly failures: readonly string[]
  ) {
    super(`${phase} failed:\n${failures.join('\n')}`);
    this.name = 'ValidationReleaseError';
  }
}

export function aggregateReleaseFailures(
  phase: string,
  failures: readonly string[]
): void {
  if (failures.length > 0) {
    throw new ValidationReleaseError(phase, failures);
  }
}
