import type { ExecResult, Logger } from '@repo/shared';
import type { MountOutboundHost } from '../outbound';
import type { MountRegistry } from '../registry';
import type { S3FSHost } from '../s3fs';

export interface BucketMountOperationContext {
  registry: MountRegistry;
  logger: Logger;
  execInternal(command: string): Promise<ExecResult>;
  getOutboundHost(): MountOutboundHost;
  getS3FSHost(): S3FSHost;
}
