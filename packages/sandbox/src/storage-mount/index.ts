/**
 * Bucket mounting functionality
 */

export { detectCredentials } from './credential-detection';
export {
  BucketMountError,
  InvalidMountConfigError,
  MissingCredentialsError,
  S3FSMountError
} from './errors';
export {
  detectProviderFromUrl,
  getProviderFlags,
  resolveS3fsOptions
} from './provider-detection';
export type { MountInfo } from './types';
export {
  buildS3fsSource,
  validateBucketName,
  validatePrefix
} from './validation';
