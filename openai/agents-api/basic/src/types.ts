export type SessionResult = {
  sessionID: string;
  output: string;
};

export interface SessionManager {
  create(input: string): Promise<SessionResult>;
  run(sessionID: string, input: string): Promise<SessionResult>;
  delete(sessionID: string): Promise<void>;
}
