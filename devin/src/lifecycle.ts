export interface DevinSessionSummary {
  metadata: { session_id: string; outpost_id: string };
  status?: {
    phase?: string | null;
    session_status?: string | null;
  };
}

export type SessionStatus = 'pending' | 'running' | 'suspended' | 'terminated';
export type SessionCommand = 'ensureRunning' | 'stop' | 'ignore';

export const SESSION_COMMANDS: Record<SessionStatus, SessionCommand> = {
  pending: 'ensureRunning',
  running: 'ensureRunning',
  suspended: 'stop',
  terminated: 'stop'
};

export function sessionCommand(
  status: string | null | undefined
): SessionCommand {
  return status && Object.hasOwn(SESSION_COMMANDS, status)
    ? SESSION_COMMANDS[status as SessionStatus]
    : 'ignore';
}

export function acceptorId(
  prefix: string | undefined,
  sessionId: string
): string {
  return `${prefix || 'cf-outpost'}-${sessionId}`;
}
