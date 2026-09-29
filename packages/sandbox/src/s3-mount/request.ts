import * as z from "zod/mini";

import {
  type S3MountAccess,
  type S3MountCredentials,
  type S3MountObservedConfiguration,
  type S3MountRequest,
  type S3MountSource,
  type S3fsOptionValue,
} from "./contracts.js";

export const S3_MOUNT_PROTOCOL_VERSION = 1;

const objectSchema = z.object({});
const stringSchema = z.string();
const fetcherSchema = z.object({ fetch: z.function() });
const finiteNumberSchema = z.number().check(z.refine(Number.isFinite));

const RESERVED_GUEST_PATHS = [
  "/proc/self/mountinfo",
  "/run/sandbox/s3-mounts",
  "/usr/local/bin/sandbox-shim",
] as const;

const RESERVED_S3FS_OPTIONS = new Set([
  "ahbe_conf",
  "allow_other",
  "compat_dir",
  "credlib",
  "ecs",
  "endpoint",
  "f",
  "fg",
  "foreground",
  "fsname",
  "host",
  "iam_role",
  "ibm_iam_auth",
  "logfile",
  "nomixupload",
  "noproxy",
  "passwd_file",
  "profile",
  "proxy",
  "proxy_cred_file",
  "public_bucket",
  "ro",
  "rw",
  "subtype",
  "use_path_request_style",
  "use_proxy",
  "use_session_token",
  "url",
]);

interface S3fsOption {
  readonly name: string;
  readonly value?: string;
}

interface CanonicalS3MountRequest {
  readonly mountPath: string;
  readonly source: S3MountSource;
  readonly keyPrefix?: string;
  readonly access: S3MountAccess;
  readonly s3fsOptions: readonly S3fsOption[];
}

export function canonicalizeS3MountRequest(request: S3MountRequest): CanonicalS3MountRequest {
  if (!objectSchema.safeParse(request).success) throw new TypeError("request must be an object");
  const mountPath = canonicalizeMountPath(request.mountPath);
  if (RESERVED_GUEST_PATHS.some((reserved) => pathsOverlap(mountPath, reserved))) {
    throw new TypeError("mountPath overlaps files required by @cloudflare/sandbox");
  }
  return {
    mountPath,
    source: canonicalizeSource(request.source),
    keyPrefix: canonicalizeKeyPrefix(request.keyPrefix),
    access: canonicalizeAccess(request.access),
    s3fsOptions: canonicalizeS3fsOptions(request.s3fsOptions),
  };
}

export function canonicalizeMountPath(value: string): string {
  const parsed = stringSchema.safeParse(value);
  if (!parsed.success || !parsed.data.startsWith("/") || parsed.data.includes("\0")) {
    throw new TypeError("mountPath must be an absolute path without NUL bytes");
  }
  value = parsed.data;
  if (value === "/") throw new TypeError("mountPath must not be the filesystem root");
  const segments = value.split("/");
  if (
    value.endsWith("/") ||
    segments.some(
      (segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."),
    )
  ) {
    throw new TypeError("mountPath must be a normalized non-root path");
  }
  return value;
}

export function observedConfiguration(
  request: CanonicalS3MountRequest,
): S3MountObservedConfiguration {
  return {
    source: {
      type: "s3",
      endpoint: request.source.endpoint,
      region: request.source.region,
      bucket: request.source.bucket,
    },
    keyPrefix: request.keyPrefix,
    access: request.access,
    s3fsOptions: request.s3fsOptions,
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonicalizeAccess(value: S3MountAccess): S3MountAccess {
  if (value !== "read-only" && value !== "read-write") {
    throw new TypeError('access must be "read-only" or "read-write"');
  }
  return value;
}

function canonicalizeKeyPrefix(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = stringSchema.safeParse(value);
  if (!parsed.success || parsed.data.startsWith("/") || parsed.data.includes("\0")) {
    throw new TypeError("keyPrefix must not start with '/' or contain NUL bytes");
  }
  return `${parsed.data.replace(/\/+$/, "")}/`;
}

function canonicalizeSource(source: S3MountSource): S3MountSource {
  if (!objectSchema.safeParse(source).success) throw new TypeError("source must be an object");
  if (source.type !== "s3") throw new TypeError('source.type must be "s3"');
  const bucket = requiredString(source.bucket, "source.bucket");
  if (bucket.startsWith("-") || bucket.includes("/") || bucket.includes(":")) {
    throw new TypeError("source.bucket must not start with '-' or contain '/' or ':'");
  }
  return {
    type: "s3",
    endpoint: canonicalizeEndpoint(source.endpoint),
    region: requiredString(source.region, "source.region"),
    bucket,
    credentials: canonicalizeCredentials(source.credentials),
  };
}

function canonicalizeEndpoint(value: string): string {
  const endpoint = requiredString(value, "source.endpoint");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("source.endpoint must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("source.endpoint must use HTTP or HTTPS");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      "source.endpoint must be an HTTP(S) origin without credentials, a path, query, or fragment",
    );
  }
  return parsed.toString();
}

function canonicalizeCredentials(credentials: S3MountCredentials): S3MountCredentials {
  if (!objectSchema.safeParse(credentials).success) {
    throw new TypeError("source.credentials must be an object");
  }
  if (credentials.type === "static") {
    return {
      type: "static",
      accessKeyId: requiredString(credentials.accessKeyId, "credentials.accessKeyId"),
      secretAccessKey: requiredString(credentials.secretAccessKey, "credentials.secretAccessKey"),
      sessionToken:
        credentials.sessionToken === undefined
          ? undefined
          : requiredString(credentials.sessionToken, "credentials.sessionToken"),
    };
  }
  if (credentials.type === "provider") {
    if (!fetcherSchema.safeParse(credentials.fetcher).success) {
      throw new TypeError("provider credentials require a Fetcher");
    }
    return { type: "provider", fetcher: credentials.fetcher };
  }
  throw new TypeError('credentials.type must be "static" or "provider"');
}

function canonicalizeS3fsOptions(
  options: Readonly<Record<string, S3fsOptionValue>> | undefined,
): readonly S3fsOption[] {
  if (options === undefined) return [];
  if (!objectSchema.safeParse(options).success)
    throw new TypeError("s3fsOptions must be an object");
  const normalized: S3fsOption[] = [];
  for (const [name, value] of Object.entries(options)) {
    if (name === "" || name.includes("\0") || name.includes(",") || name.includes("=")) {
      throw new TypeError("s3fs option names must not be empty or contain NUL, ',' or '='");
    }
    if (RESERVED_S3FS_OPTIONS.has(name.toLowerCase())) {
      throw new TypeError(`s3fs option "${name}" is owned by @cloudflare/sandbox`);
    }
    if (value === false) continue;
    if (value === true) {
      normalized.push({ name });
      continue;
    }
    const numberValue = finiteNumberSchema.safeParse(value);
    if (numberValue.success) {
      normalized.push({ name, value: String(numberValue.data) });
      continue;
    }
    const stringValue = stringSchema.safeParse(value);
    if (!stringValue.success || stringValue.data.includes("\0") || stringValue.data.includes(",")) {
      throw new TypeError(`s3fs option "${name}" has an invalid value`);
    }
    normalized.push({ name, value: stringValue.data });
  }
  return normalized.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
}

function requiredString(value: string, name: string): string {
  const parsed = stringSchema.safeParse(value);
  if (!parsed.success || parsed.data === "" || parsed.data.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty string without NUL bytes`);
  }
  return parsed.data;
}
