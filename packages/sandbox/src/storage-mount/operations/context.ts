import type { Logger } from '@repo/shared';
import type { MountOutboundHost } from '../outbound';
import type { MountRegistry } from '../registry';
import type { MountRuntimeCall } from '../runtime-call';
import type { S3FSHost } from '../s3fs';

export interface BucketMountOperationContext {
  registry: MountRegistry;
  logger: Logger;
  runRuntimeCall: MountRuntimeCall;
  getOutboundHost(): MountOutboundHost;
  s3fsHost: S3FSHost | null;
}
