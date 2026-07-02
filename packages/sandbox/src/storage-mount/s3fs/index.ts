import type { BucketProvider, RemoteMountBucketOptions } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import { InvalidMountConfigError, S3FSMountError } from '../errors';
import type { FuseMountInfo, R2BindingMountInfo } from '../types';
import { resolveS3fsOptions } from '../validation/provider';

export type { S3FSHost } from './host';

import type { S3FSHost } from './host';

export {
  createDisableExpectHeaderFile,
  createPasswordFile,
  deleteAdditionalHeaderFile,
  deletePasswordFile,
  generatePasswordFilePath,
  generateS3FSAdditionalHeaderFilePath
} from './support-files';
export const R2_DEFAULT_S3FS_OPTIONS: Readonly<
  Record<string, string | boolean>
> = {
  stat_cache_expire: '60',
  enable_noobj_cache: true,
  multipart_size: '5'
};

export const R2_DEFAULT_S3FS_OPTION_ENTRIES = Object.entries(
  R2_DEFAULT_S3FS_OPTIONS
).map(([key, value]) => (value === true ? key : `${key}=${value}`));

export function sh(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += shellEscape(String(values[i])) + strings[i + 1];
  }
  return out;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseS3fsOptions(
  entries: string[]
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq === -1) {
      result[entry] = true;
    } else {
      result[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return result;
}

export function serializeS3fsOptions(
  options: Record<string, string | boolean>
): string {
  return Object.entries(options)
    .filter(([, value]) => value !== false)
    .map(([key, value]) => (value === true ? key : `${key}=${value}`))
    .join(',');
}

export function validateProtectedS3fsOptions(
  options: string[] | undefined,
  mountLabel: string,
  extraProtected: string[] = []
): void {
  if (!options) return;
  const protectedOptions = new Set(['passwd_file', 'url', ...extraProtected]);
  for (const option of options) {
    const [key] = option.split('=');
    if (protectedOptions.has(key)) {
      throw new InvalidMountConfigError(
        `s3fs option "${key}" cannot be overridden for ${mountLabel} mounts`
      );
    }
  }
}

export async function executeS3FSMount(
  host: S3FSHost,
  params: {
    bucket: string;
    mountPath: string;
    options: RemoteMountBucketOptions;
    provider: BucketProvider | null;
    passwordFilePath: string;
    sessionId?: string;
  }
): Promise<void> {
  const logSuffix = randomHex(4);
  const sdkDefaults: Record<string, string | boolean> = {
    logfile: `/tmp/.s3fs-log-${logSuffix}`
  };
  const s3fsOptions: Record<string, string | boolean> = {
    ...sdkDefaults,
    ...parseS3fsOptions(resolveS3fsOptions(params.provider)),
    ...parseS3fsOptions(params.options.s3fsOptions ?? []),
    passwd_file: params.passwordFilePath,
    url: params.options.endpoint,
    ...(params.options.readOnly ? { ro: true } : {})
  };
  const logFile = s3fsOptions.logfile as string;
  const optionsStr = serializeS3fsOptions(s3fsOptions);

  const script = sh`(
    s3fs ${params.bucket} ${params.mountPath} -o ${optionsStr} >${logFile} 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then tail -n 20 ${logFile} 2>/dev/null || true; exit 2; fi
    for _ in $(seq 1 60); do
      if mountpoint -q ${params.mountPath}; then exit 0; fi
      sleep 0.1
    done
    tail -n 20 ${logFile} 2>/dev/null || true
    exit 3
  )`;

  const exec =
    params.sessionId && host.executeCommand
      ? (command: string) =>
          host.executeCommand!(command, params.sessionId!, {
            origin: 'internal'
          })
      : (command: string) => host.execInternal(command);

  const result = await exec(script);
  if (result.exitCode === 0) return;

  const detail = result.stdout?.trim() || result.stderr?.trim() || '';
  if (result.exitCode === 2) {
    throw new S3FSMountError(`S3FS mount failed: ${detail || 'Unknown error'}`);
  }

  const diagMessage = detail
    ? `s3fs log: ${detail}`
    : 'No s3fs log output captured. The s3fs daemon may have exited before writing logs.';
  throw new S3FSMountError(
    `S3FS mount failed: FUSE filesystem never appeared at ${params.mountPath}. ${diagMessage}`
  );
}

export async function unmountTrackedFuseMount(
  host: S3FSHost,
  mountPath: string,
  mountInfo: FuseMountInfo | R2BindingMountInfo
): Promise<boolean> {
  if (!mountInfo.mounted) return true;

  host.logger.debug(`Unmounting bucket ${mountInfo.bucket} from ${mountPath}`);
  const result = await host.execInternal(
    `fusermount -u ${shellEscape(mountPath)}`
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `fusermount -u failed (exit ${result.exitCode}): ${result.stderr || 'unknown error'}`
    );
  }
  mountInfo.mounted = false;
  return true;
}
