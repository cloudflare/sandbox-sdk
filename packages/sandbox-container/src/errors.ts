/**
 * The shell process exited without an API-initiated destroy().
 * Covers user-initiated exits (`exit 0`) and unexpected crashes.
 */
export class ShellTerminatedError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly exitCode: number | null
  ) {
    super(
      `Shell terminated unexpectedly (exit code: ${exitCode ?? 'unknown'}). Session is dead and cannot execute further commands.`
    );
    this.name = 'ShellTerminatedError';
  }
}

/**
 * destroy() killed the shell while commands were in flight.
 */
export class SessionDestroyedError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session '${sessionId}' was destroyed during command execution`);
    this.name = 'SessionDestroyedError';
  }
}
