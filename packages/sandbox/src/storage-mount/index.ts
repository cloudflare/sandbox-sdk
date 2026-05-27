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
