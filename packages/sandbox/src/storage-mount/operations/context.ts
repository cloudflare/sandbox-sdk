import type { Logger, SandboxMountsAPI } from '@repo/shared';
import type { MountOutboundHost } from '../outbound';
import type { MountRegistry } from '../registry';
import type { S3FSHost } from '../s3fs';

export interface BucketMountOperationContext {
  registry: MountRegistry;
  logger: Logger;
  getMounts(): SandboxMountsAPI;
  getOutboundHost(): MountOutboundHost;
  getS3FSHost(): S3FSHost;
}
