import {
  SandboxSecurityError,
  sanitizeSandboxId,
  validatePort
} from '../security';
import { isLocalhostPattern } from './url';

export interface PreviewRouteInfo {
  port: number;
  sandboxId: string;
  token: string;
}

export interface ConstructPreviewURLOptions {
  port: number;
  sandboxId: string;
  effectiveId: string;
  hostname: string;
  token: string;
  normalizeId: boolean;
}

export function parsePreviewRoute(url: URL): PreviewRouteInfo | null {
  // URL format: {port}-{sandboxId}-{token}.{domain}
  // Tokens are [a-z0-9_]+, so split at the last hyphen to handle sandbox IDs
  // with hyphens such as UUIDs.
  const dotIndex = url.hostname.indexOf('.');
  if (dotIndex === -1) {
    return null;
  }

  const subdomain = url.hostname.slice(0, dotIndex);

  const firstHyphen = subdomain.indexOf('-');
  if (firstHyphen === -1) {
    return null;
  }

  const portStr = subdomain.slice(0, firstHyphen);
  if (!/^\d{4,5}$/.test(portStr)) {
    return null;
  }

  const port = Number.parseInt(portStr, 10);
  if (!validatePort(port)) {
    return null;
  }

  const rest = subdomain.slice(firstHyphen + 1);
  const lastHyphen = rest.lastIndexOf('-');
  if (lastHyphen === -1) {
    return null;
  }

  const sandboxId = rest.slice(0, lastHyphen);
  const token = rest.slice(lastHyphen + 1);

  if (!/^[a-z0-9_]+$/.test(token) || token.length === 0 || token.length > 63) {
    return null;
  }

  if (sandboxId.length === 0 || sandboxId.length > 63) {
    return null;
  }

  let sanitizedSandboxId: string;
  try {
    sanitizedSandboxId = sanitizeSandboxId(sandboxId);
  } catch {
    return null;
  }

  return {
    port,
    sandboxId: sanitizedSandboxId,
    token
  };
}

export function constructPreviewURL({
  port,
  sandboxId,
  effectiveId,
  hostname,
  token,
  normalizeId
}: ConstructPreviewURLOptions): string {
  if (!validatePort(port)) {
    throw new SandboxSecurityError(
      `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
    );
  }

  const hasUppercase = /[A-Z]/.test(effectiveId);
  if (!normalizeId && hasUppercase) {
    throw new SandboxSecurityError(
      `Preview URLs require lowercase sandbox IDs. Your ID "${effectiveId}" contains uppercase letters.\n\n` +
        `To fix this:\n` +
        `1. Create a new sandbox with: getSandbox(ns, "${effectiveId}", { normalizeId: true })\n` +
        `2. This will create a sandbox with ID: "${effectiveId.toLowerCase()}"\n\n` +
        `Note: Due to DNS case-insensitivity, IDs with uppercase letters cannot be used with preview URLs.`
    );
  }

  const sanitizedSandboxId = sanitizeSandboxId(sandboxId).toLowerCase();
  const isLocalhost = isLocalhostPattern(hostname);

  if (isLocalhost) {
    const [host, portStr] = hostname.split(':');
    const mainPort = portStr || '80';

    try {
      const baseURL = new URL(`http://${host}:${mainPort}`);
      const subdomainHost = `${port}-${sanitizedSandboxId}-${token}.${host}`;
      baseURL.hostname = subdomainHost;

      return baseURL.toString();
    } catch (error) {
      throw new SandboxSecurityError(
        `Failed to construct preview URL: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  try {
    const baseURL = new URL(`https://${hostname}`);
    const subdomainHost = `${port}-${sanitizedSandboxId}-${token}.${hostname}`;
    baseURL.hostname = subdomainHost;

    return baseURL.toString();
  } catch (error) {
    throw new SandboxSecurityError(
      `Failed to construct preview URL: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
  }
}
