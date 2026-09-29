import { type ActiveS3GatewayProps } from "./contracts.js";
import { routeHost } from "./route.js";

export interface AuthorizedS3Request {
  readonly inspection: boolean;
  readonly upstreamUrl: string;
}

interface RejectedS3Request {
  readonly detail: string;
}

type S3RequestAuthorization = AuthorizedS3Request | RejectedS3Request;

interface S3fsOperation {
  readonly kind: "bucket" | "list" | "object";
  readonly mutation: boolean;
  readonly prefix?: string;
  readonly version?: 1 | 2;
}

const LIST_V1_PARAMETERS = new Set(["delimiter", "encoding-type", "marker", "max-keys", "prefix"]);
const LIST_V2_PARAMETERS = new Set([
  "continuation-token",
  "delimiter",
  "encoding-type",
  "fetch-owner",
  "list-type",
  "max-keys",
  "prefix",
  "start-after",
]);
const SUPPORTED_AMZ_HEADERS = new Set([
  "authorization",
  "x-amz-content-sha256",
  "x-amz-copy-source",
  "x-amz-copy-source-if-match",
  "x-amz-copy-source-if-modified-since",
  "x-amz-copy-source-if-none-match",
  "x-amz-copy-source-if-unmodified-since",
  "x-amz-copy-source-range",
  "x-amz-date",
  "x-amz-metadata-directive",
  "x-amz-security-token",
]);
const COPY_CONTROL_HEADERS = [
  "x-amz-copy-source-if-match",
  "x-amz-copy-source-if-modified-since",
  "x-amz-copy-source-if-none-match",
  "x-amz-copy-source-if-unmodified-since",
  "x-amz-copy-source-range",
] as const;

export async function authorizeS3Request(
  request: Request,
  props: ActiveS3GatewayProps,
): Promise<S3RequestAuthorization> {
  const url = new URL(request.url);
  if (url.hostname !== routeHost(props.routeId)) {
    return { detail: "request host does not match the mount route" };
  }
  if (usesAwsChunkedPayload(request.headers)) {
    return { detail: "aws-chunked payloads are not supported" };
  }
  const unsupportedHeader = unsupportedAmzHeader(request.headers);
  if (unsupportedHeader !== undefined) {
    return { detail: `S3 header ${unsupportedHeader} is not permitted for this mount` };
  }

  const target = parseTarget(url.pathname);
  if (target === undefined || target.bucket !== props.source.bucket) {
    return { detail: "request is outside the mounted bucket" };
  }

  const operation = classifyS3fsOperation(request.method.toUpperCase(), target.key, url);
  if (operation === undefined) {
    return { detail: "request is not a supported s3fs operation" };
  }
  if (props.access === "read-only" && operation.mutation) {
    return { detail: "the mount is read-only" };
  }

  if (operation.kind === "object") {
    if (!isObjectWithinPrefix(target.key, props.keyPrefix)) {
      return { detail: "request is outside the mounted key prefix" };
    }
  } else if (operation.kind === "list" && !isListWithinPrefix(operation.prefix, props.keyPrefix)) {
    return { detail: "list request is outside the mounted key prefix" };
  }

  const copySource = request.headers.get("x-amz-copy-source");
  if (copySource === null && COPY_CONTROL_HEADERS.some((name) => request.headers.has(name))) {
    return { detail: "copy controls require a copy source" };
  }
  if (copySource !== null) {
    if (operation.kind !== "object" || request.method.toUpperCase() !== "PUT") {
      return { detail: "copy source is not valid for this operation" };
    }
    if (!isScopedCopySource(copySource, props)) {
      return { detail: "copy source is outside the mounted bucket or key prefix" };
    }
  }
  const metadataDirective = request.headers.get("x-amz-metadata-directive");
  if (
    metadataDirective !== null &&
    (copySource === null || (metadataDirective !== "COPY" && metadataDirective !== "REPLACE"))
  ) {
    return { detail: "invalid copy metadata directive" };
  }
  if (
    hasMetadataHeader(request.headers) &&
    (operation.kind !== "object" ||
      (request.method.toUpperCase() !== "PUT" && request.method.toUpperCase() !== "POST"))
  ) {
    return { detail: "object metadata is not valid for this operation" };
  }

  return {
    inspection: isInspectionRequest(request, operation, props),
    upstreamUrl: upstreamUrl(url, props.source.endpoint),
  };
}

function unsupportedAmzHeader(headers: Headers): string | undefined {
  for (const [name] of headers) {
    const lowerName = name.toLowerCase();
    if (
      lowerName.startsWith("x-amz-") &&
      !lowerName.startsWith("x-amz-meta-") &&
      !SUPPORTED_AMZ_HEADERS.has(lowerName)
    ) {
      return lowerName;
    }
  }
  return undefined;
}

function hasMetadataHeader(headers: Headers): boolean {
  for (const [name] of headers) {
    if (name.toLowerCase().startsWith("x-amz-meta-")) return true;
  }
  return false;
}

export function isAuthorizedS3Request(
  authorization: S3RequestAuthorization,
): authorization is AuthorizedS3Request {
  return "upstreamUrl" in authorization;
}

function classifyS3fsOperation(method: string, key: string, url: URL): S3fsOperation | undefined {
  if (hasDuplicateParameters(url.searchParams)) return undefined;
  if (key === "") return classifyBucketOperation(method, url.searchParams);
  return classifyObjectOperation(method, url.searchParams);
}

function classifyBucketOperation(
  method: string,
  parameters: URLSearchParams,
): S3fsOperation | undefined {
  if (method === "HEAD" && parameters.size === 0) {
    return { kind: "bucket", mutation: false };
  }
  if (method !== "GET") return undefined;
  if (hasExactEmptyParameters(parameters, ["location"])) {
    return { kind: "bucket", mutation: false };
  }
  return classifyListOperation(parameters);
}

function classifyListOperation(parameters: URLSearchParams): S3fsOperation | undefined {
  const listType = parameters.get("list-type");
  if (listType === "2") {
    if (!hasOnlyAllowedParameters(parameters, LIST_V2_PARAMETERS)) return undefined;
    if (!hasValidListParameters(parameters, 2)) return undefined;
    return {
      kind: "list",
      mutation: false,
      prefix: parameters.get("prefix") ?? undefined,
      version: 2,
    };
  }
  if (listType !== null || !hasOnlyAllowedParameters(parameters, LIST_V1_PARAMETERS)) {
    return undefined;
  }
  if (!hasValidListParameters(parameters, 1)) return undefined;
  return {
    kind: "list",
    mutation: false,
    prefix: parameters.get("prefix") ?? undefined,
    version: 1,
  };
}

function classifyObjectOperation(
  method: string,
  parameters: URLSearchParams,
): S3fsOperation | undefined {
  if (parameters.size === 0) {
    if (method === "GET" || method === "HEAD") return { kind: "object", mutation: false };
    if (method === "PUT" || method === "DELETE") return { kind: "object", mutation: true };
    return undefined;
  }
  if (method === "POST" && hasExactEmptyParameters(parameters, ["uploads"])) {
    return { kind: "object", mutation: true };
  }
  if (
    method === "PUT" &&
    hasExactParameters(parameters, ["partNumber", "uploadId"]) &&
    isIntegerInRange(parameters.get("partNumber"), 1, 10_000) &&
    isNonEmpty(parameters.get("uploadId"))
  ) {
    return { kind: "object", mutation: true };
  }
  if (
    (method === "POST" || method === "DELETE") &&
    hasExactParameters(parameters, ["uploadId"]) &&
    isNonEmpty(parameters.get("uploadId"))
  ) {
    return { kind: "object", mutation: true };
  }
  return undefined;
}

function hasValidListParameters(parameters: URLSearchParams, version: 1 | 2): boolean {
  const maxKeys = parameters.get("max-keys");
  if (maxKeys !== null && !isIntegerInRange(maxKeys, 0, 1_000)) return false;
  const encodingType = parameters.get("encoding-type");
  if (encodingType !== null && encodingType !== "url") return false;
  if (version === 2) {
    const fetchOwner = parameters.get("fetch-owner");
    if (fetchOwner !== null && fetchOwner !== "true" && fetchOwner !== "false") return false;
    if (parameters.has("continuation-token") && parameters.has("start-after")) return false;
    if (parameters.has("continuation-token") && !isNonEmpty(parameters.get("continuation-token"))) {
      return false;
    }
  }
  return true;
}

function parseTarget(
  pathname: string,
): { readonly bucket: string; readonly key: string } | undefined {
  if (!pathname.startsWith("/")) return undefined;
  const separator = pathname.indexOf("/", 1);
  const encodedBucket = separator === -1 ? pathname.slice(1) : pathname.slice(1, separator);
  if (encodedBucket === "") return undefined;
  const encodedKey = separator === -1 ? "" : pathname.slice(separator + 1);
  try {
    return {
      bucket: decodeURIComponent(encodedBucket),
      key: decodeURIComponent(encodedKey),
    };
  } catch {
    return undefined;
  }
}

function isObjectWithinPrefix(key: string, prefix: string | undefined): boolean {
  if (prefix === undefined) return true;
  return key === prefix.slice(0, -1) || key.startsWith(prefix);
}

function isListWithinPrefix(value: string | undefined, prefix: string | undefined): boolean {
  if (prefix === undefined) return true;
  return value !== undefined && (value === prefix || value.startsWith(prefix));
}

function hasDuplicateParameters(parameters: URLSearchParams): boolean {
  const names = new Set<string>();
  for (const name of parameters.keys()) {
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

function hasOnlyAllowedParameters(
  parameters: URLSearchParams,
  allowed: ReadonlySet<string>,
): boolean {
  for (const name of parameters.keys()) {
    if (!allowed.has(name)) return false;
  }
  return true;
}

function hasExactParameters(parameters: URLSearchParams, expected: readonly string[]): boolean {
  if (parameters.size !== expected.length) return false;
  return expected.every((name) => parameters.has(name));
}

function hasExactEmptyParameters(
  parameters: URLSearchParams,
  expected: readonly string[],
): boolean {
  return (
    hasExactParameters(parameters, expected) &&
    expected.every((name) => parameters.get(name) === "")
  );
}

function isIntegerInRange(value: string | null, minimum: number, maximum: number): boolean {
  if (value === null) return false;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function isNonEmpty(value: string | null): boolean {
  return value !== null && value !== "";
}

function isScopedCopySource(value: string, props: ActiveS3GatewayProps): boolean {
  if (value === "" || value.includes("?")) return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(value);
  } catch {
    return false;
  }
  const path = decodedPath.startsWith("/") ? decodedPath.slice(1) : decodedPath;
  const separator = path.indexOf("/");
  if (separator <= 0 || separator === path.length - 1) return false;
  const key = path.slice(separator + 1);
  return (
    path.slice(0, separator) === props.source.bucket && isObjectWithinPrefix(key, props.keyPrefix)
  );
}

function isInspectionRequest(
  request: Request,
  operation: S3fsOperation,
  props: ActiveS3GatewayProps,
): boolean {
  if (
    operation.kind !== "list" ||
    operation.version !== 2 ||
    request.headers.get("user-agent") !== "sandbox-shim/1"
  ) {
    return false;
  }
  const url = new URL(request.url);
  return url.searchParams.get("max-keys") === "1" && operation.prefix === props.keyPrefix;
}

function upstreamUrl(url: URL, endpoint: string): string {
  const upstream = new URL(endpoint);
  upstream.pathname = url.pathname;
  upstream.search = url.search;
  return upstream.toString();
}

function usesAwsChunkedPayload(headers: Headers): boolean {
  const payloadHash = headers.get("x-amz-content-sha256");
  if (payloadHash?.startsWith("STREAMING-") === true) return true;
  return (headers.get("content-encoding") ?? "")
    .split(",")
    .some((encoding) => encoding.trim().toLowerCase() === "aws-chunked");
}
