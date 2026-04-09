/**
 * Bucket mounting functionality
 */

export { detectCredentials } from './credential-detection';
export {
  BucketMountError,
  BucketUnmountError,
  InvalidMountConfigError,
  MissingCredentialsError,
  S3FSMountError
} from './errors';
export {
  detectProviderFromUrl,
  getProviderFlags,
  resolveS3fsOptions
} from './provider-detection';
export type { FuseMountInfo, LocalSyncMountInfo, MountInfo } from './types';
export {
  buildS3fsSource,
  validateBucketName,
  validatePrefix
} from './validation';
