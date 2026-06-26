/**
 * Bucket mounting functionality
 */

export {
  BucketMountError,
  BucketUnmountError,
  InvalidMountConfigError,
  MissingCredentialsError,
  S3FSMountError
} from './errors';
export { MountLifecycle, type MountLifecycleSnapshot } from './lifecycle';
export type { BucketMountDestroyCleanupResult } from './lifecycle-cleanup';
export { MountOperationQueue } from './operation-queue';
export {
  configureGitAuthInterceptor,
  configureR2EgressOutbound,
  configureS3CredentialProxyOutbound,
  type EgressContainerState,
  type MountOutboundHost
} from './outbound';
export {
  CONTAINER_PROXY_CLASS_NAME,
  ContainerProxy,
  type OutboundHandlerRegistry,
  S3_CREDENTIAL_PROXY_DIAGNOSTIC_HOST,
  S3_CREDENTIAL_PROXY_HOST
} from './outbound/container-proxy';
export { MountRegistry } from './registry';
export {
  createDisableExpectHeaderFile,
  createPasswordFile,
  deleteAdditionalHeaderFile,
  deletePasswordFile,
  executeS3FSMount,
  generatePasswordFilePath,
  generateS3FSAdditionalHeaderFilePath,
  parseS3fsOptions,
  R2_DEFAULT_S3FS_OPTION_ENTRIES,
  R2_DEFAULT_S3FS_OPTIONS,
  type S3FSHost,
  serializeS3fsOptions,
  unmountTrackedFuseMount,
  validateProtectedS3fsOptions
} from './s3fs';
export { BucketMountService, type BucketMountServiceDeps } from './service';
export type {
  FuseMountInfo,
  LocalSyncMountInfo,
  MountInfo,
  R2BindingMountInfo,
  R2EgressMountInfo
} from './types';
export {
  buildS3fsSource,
  isR2Bucket,
  validateBucketBindingName,
  validateBucketName,
  validatePrefix
} from './validation';
export { detectCredentials } from './validation/credentials';
export {
  detectProviderFromUrl,
  getProviderFlags,
  resolveS3fsOptions
} from './validation/provider';
