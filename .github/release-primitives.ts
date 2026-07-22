import { isAbsolute, normalize, relative, sep } from 'node:path';

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type StableVersion = Brand<string, 'StableVersion'>;
export type CommitSHA = Brand<string, 'CommitSHA'>;
export type SourceTag = Brand<string, 'SourceTag'>;
export type VersionTag = Brand<string, 'VersionTag'>;
export type AbsolutePath = Brand<string, 'AbsolutePath'>;
export type NpmPackageName = Brand<string, 'NpmPackageName'>;
export type ImageDigest = Brand<string, 'ImageDigest'>;

export function stableVersion(value: string): StableVersion {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Stable version must be MAJOR.MINOR.PATCH: ${value}`);
  }
  return value as StableVersion;
}

export function commitSHA(value: string): CommitSHA {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('Commit SHA must be 40 lowercase hex characters');
  }
  return value as CommitSHA;
}

export function sourceTag(value: string): SourceTag {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid source tag: ${value}`);
  }
  return value as SourceTag;
}

export function versionTag(value: string): VersionTag {
  const prefix = '@cloudflare/sandbox@';
  if (!value.startsWith(prefix)) {
    throw new Error(`Invalid version tag: ${value}`);
  }
  try {
    stableVersion(value.slice(prefix.length));
  } catch {
    throw new Error(`Invalid version tag: ${value}`);
  }
  return value as VersionTag;
}

export function absolutePath(value: string): AbsolutePath {
  if (!isAbsolute(value)) {
    throw new Error(`Expected absolute path: ${value}`);
  }
  return normalize(value) as AbsolutePath;
}

export function assertPathInside(
  root: AbsolutePath,
  child: string
): AbsolutePath {
  const normalized = absolutePath(child);
  const rel = relative(root, normalized);
  const escapesRoot = rel === '..' || rel.startsWith(`..${sep}`);
  if (!escapesRoot && !isAbsolute(rel)) {
    return normalized;
  }
  throw new Error(`Release path escapes releaseRoot: ${child}`);
}

export function npmPackageName(value: string): NpmPackageName {
  if (value !== '@cloudflare/sandbox') {
    throw new Error(`Unsupported npm package: ${value}`);
  }
  return value as NpmPackageName;
}

export function imageDigest(value: string): ImageDigest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid image digest: ${value}`);
  }
  return value as ImageDigest;
}
