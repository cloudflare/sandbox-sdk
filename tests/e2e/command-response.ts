import type { SandboxCommand } from '../../packages/shared/src/process-types';

export interface CommandResponse {
  success: boolean;
  exitCode: number;
  signal?: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  command: SandboxCommand;
  duration: number;
  timestamp: string;
}
