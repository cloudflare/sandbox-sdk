/** @internal */
export const PREVIEW_PROXY_HEADER = 'x-sandbox-preview-proxy';
/** @internal */
export const PREVIEW_PROXY_PORT_HEADER = 'x-sandbox-preview-port';
/** @internal */
export const PREVIEW_PROXY_TOKEN_HEADER = 'x-sandbox-preview-token';
/** @internal */
export const PREVIEW_PROXY_SANDBOX_ID_HEADER = 'x-sandbox-preview-sandbox-id';

/** @internal */
export const PREVIEW_PROXY_HEADERS = [
  PREVIEW_PROXY_HEADER,
  PREVIEW_PROXY_PORT_HEADER,
  PREVIEW_PROXY_TOKEN_HEADER,
  PREVIEW_PROXY_SANDBOX_ID_HEADER
] as const;
