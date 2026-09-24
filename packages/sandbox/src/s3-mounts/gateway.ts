import { AwsClient } from "aws4fetch";

import { readBoundedBody } from "../shared/bounded-body.js";
import { type S3GatewayProps } from "./contracts.js";
import { CredentialProviderError, resolveS3Credentials } from "./credentials.js";
import { authorizeS3Request, isAuthorizedS3Request } from "./gateway-policy.js";

const INSPECTION_VERSION_HEADER = "x-sandbox-s3-gateway-version";
const INSPECTION_RESULT_HEADER = "x-sandbox-s3-inspection-result";
const INSPECTION_DETAIL_HEADER = "x-sandbox-s3-inspection-detail";
const MAX_INSPECTION_DETAIL_LENGTH = 1_024;
const MAX_S3_ERROR_BODY_BYTES = 64 * 1_024;

const FORWARDED_HEADERS = new Set([
  "content-length",
  "content-md5",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
  "x-amz-copy-source",
  "x-amz-copy-source-if-match",
  "x-amz-copy-source-if-modified-since",
  "x-amz-copy-source-if-none-match",
  "x-amz-copy-source-if-unmodified-since",
  "x-amz-copy-source-range",
  "x-amz-metadata-directive",
]);

type InspectionResult =
  | "gateway-credential-provider"
  | "gateway-internal"
  | "gateway-protocol"
  | "rejected-access"
  | "rejected-credentials"
  | "rejected-not-found"
  | "rejected-other"
  | "unavailable"
  | "usable";

export async function handleS3GatewayRequest(
  request: Request,
  props: S3GatewayProps,
): Promise<Response> {
  if (props.protocolVersion !== 1) {
    return inspectionResponse("gateway-protocol", "gateway protocol is incompatible", 500);
  }
  if (props.mode === "deny") {
    return inspectionResponse("rejected-access", "mount route has been revoked", 403);
  }

  const authorization = await authorizeS3Request(request, props);
  if (!isAuthorizedS3Request(authorization)) {
    return inspectionResponse("rejected-access", authorization.detail, 403);
  }
  let credentials;
  try {
    credentials = await resolveS3Credentials(props.source.credentials, request.signal);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    return inspectionResponse(
      "gateway-credential-provider",
      error instanceof CredentialProviderError ? error.message : "credential provider failed",
      503,
    );
  }

  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    service: "s3",
    region: props.source.region,
    retries: 0,
  });

  let upstream: Response;
  try {
    upstream = await client.fetch(authorization.upstreamUrl, {
      method: request.method,
      headers: forwardingHeaders(request.headers),
      body: request.body,
      signal: request.signal,
    });
  } catch (error) {
    if (!authorization.inspection) throw error;
    return inspectionResponse(
      "unavailable",
      error instanceof Error ? error.message : "upstream request failed",
      503,
    );
  }

  if (!authorization.inspection) return upstream;
  return classifyInspectionResponse(upstream);
}

function forwardingHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    const lowerName = name.toLowerCase();
    if (lowerName === "x-amz-content-sha256") {
      if (isPayloadHash(value)) headers.set(name, value);
      continue;
    }
    if (FORWARDED_HEADERS.has(lowerName) || lowerName.startsWith("x-amz-meta-")) {
      headers.set(name, value);
    }
  }
  if (!headers.has("x-amz-content-sha256")) {
    headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
  }
  return headers;
}

function isPayloadHash(value: string): boolean {
  return value === "UNSIGNED-PAYLOAD" || /^[a-fA-F0-9]{64}$/.test(value);
}

async function classifyInspectionResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return inspectionResponse("usable", "upstream list request succeeded", response.status);
  }
  if (response.status === 401) {
    return inspectionResponse(
      "rejected-credentials",
      `upstream rejected credentials with HTTP ${response.status}`,
      response.status,
    );
  }
  if (response.status === 403) {
    const code = await readS3ErrorCode(response.body);
    const credentialsRejected = code !== undefined && CREDENTIAL_ERROR_CODES.has(code);
    return inspectionResponse(
      credentialsRejected ? "rejected-credentials" : "rejected-access",
      code === undefined
        ? "upstream denied the inspection request"
        : `upstream denied the inspection request with ${code}`,
      response.status,
    );
  }
  if (response.status === 404) {
    return inspectionResponse(
      "rejected-not-found",
      "upstream bucket was not found",
      response.status,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    return inspectionResponse(
      "unavailable",
      `upstream returned HTTP ${response.status}`,
      response.status,
    );
  }
  return inspectionResponse(
    "rejected-other",
    `upstream rejected the request with HTTP ${response.status}`,
    response.status,
  );
}

const CREDENTIAL_ERROR_CODES = new Set([
  "AuthorizationHeaderMalformed",
  "ExpiredToken",
  "InvalidAccessKeyId",
  "InvalidToken",
  "RequestTimeTooSkewed",
  "SignatureDoesNotMatch",
  "TokenRefreshRequired",
]);

async function readS3ErrorCode(
  body: ReadableStream<Uint8Array> | null,
): Promise<string | undefined> {
  const result = await readBoundedBody(
    body,
    MAX_S3_ERROR_BODY_BYTES,
    "S3 error body exceeded the inspection limit",
  );
  if (result.status !== "complete") return undefined;
  const match = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(new TextDecoder().decode(result.bytes));
  return match?.[1];
}

function inspectionResponse(result: InspectionResult, detail: string, status: number): Response {
  const boundedDetail = detail.slice(0, MAX_INSPECTION_DETAIL_LENGTH);
  return new Response(null, {
    status,
    headers: {
      [INSPECTION_VERSION_HEADER]: "1",
      [INSPECTION_RESULT_HEADER]: result,
      [INSPECTION_DETAIL_HEADER]: encodeURIComponent(boundedDetail),
    },
  });
}
