import type { ExecOptions, ExecResult, Logger } from '@repo/shared';
import type { ContainerControlClient } from '../../container-control';

export interface S3FSHost {
  client: ContainerControlClient;
  logger: Logger;
  execInternal(command: string): Promise<ExecResult>;
  executeCommand?(
    command: string,
    sessionId: string,
    options?: ExecOptions
  ): Promise<ExecResult>;
}
