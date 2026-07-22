import type { Logger } from '@repo/shared';
import type { MountRuntimeCall } from '../runtime-call';

export interface S3FSHost {
  runRuntimeCall: MountRuntimeCall;
  logger: Logger;
}
