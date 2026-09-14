import * as z from "zod/mini";

import { readBoundedBody } from "../shared/bounded-body.js";
import { type S3MountCredentials } from "./contracts.js";

const CREDENTIAL_PROVIDER_URL = "https://credentials.sandbox.internal/";
const MAX_CREDENTIAL_RESPONSE_BYTES = 16 * 1_024;
const decoder = new TextDecoder("utf-8", { fatal: true });

const credentialResponseSchema = z.strictObject({
  accessKeyId: z.string().check(z.minLength(1), z.regex(/^[^\0]+$/)),
  secretAccessKey: z.string().check(z.minLength(1), z.regex(/^[^\0]+$/)),
  sessionToken: z.optional(z.string().check(z.minLength(1), z.regex(/^[^\0]+$/))),
  expiresAt: z.number().check(z.int()),
});

type CredentialResponse = z.infer<typeof credentialResponseSchema>;

export interface ResolvedS3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export class CredentialProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialProviderError";
  }
}

export async function resolveS3Credentials(
  credentials: S3MountCredentials,
  signal: AbortSignal,
): Promise<ResolvedS3Credentials> {
  if (credentials.type === "static") return credentials;
  signal.throwIfAborted();

  let response: Response;
  try {
    response = await credentials.fetcher.fetch(CREDENTIAL_PROVIDER_URL, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new CredentialProviderError("credential provider request failed", { cause: error });
  }
  if (!response.ok) {
    throw new CredentialProviderError(`credential provider returned HTTP ${response.status}`);
  }

  const credentialsResponse = await readCredentialResponse(response.body);
  if (credentialsResponse.expiresAt <= Date.now()) {
    throw new CredentialProviderError(
      "credential provider returned invalid or expired credentials",
    );
  }
  return {
    accessKeyId: credentialsResponse.accessKeyId,
    secretAccessKey: credentialsResponse.secretAccessKey,
    sessionToken: credentialsResponse.sessionToken,
  };
}

async function readCredentialResponse(
  body: ReadableStream<Uint8Array> | null,
): Promise<CredentialResponse> {
  const result = await readBoundedBody(
    body,
    MAX_CREDENTIAL_RESPONSE_BYTES,
    "credential provider response exceeded the gateway limit",
  );
  if (result.status === "absent") {
    throw new CredentialProviderError("credential provider returned invalid JSON");
  }
  if (result.status === "exceeded") {
    throw new CredentialProviderError("credential provider response is too large");
  }
  try {
    const parsed = credentialResponseSchema.safeParse(JSON.parse(decoder.decode(result.bytes)));
    if (!parsed.success) {
      throw new CredentialProviderError(
        "credential provider returned invalid or expired credentials",
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CredentialProviderError) throw error;
    throw new CredentialProviderError("credential provider returned invalid JSON", {
      cause: error,
    });
  }
}
