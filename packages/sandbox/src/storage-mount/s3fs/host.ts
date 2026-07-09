import type { Logger } from '@repo/shared';
import type { ContainerControlClient } from '../../container-control';

export interface S3FSHost {
  client: ContainerControlClient;
  logger: Logger;
}
