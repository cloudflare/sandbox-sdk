import type { RuntimeScoped } from '../current-runtime-identity';

/**
 * Persisted record for a single exposed port. `token` authorizes preview
 * URL requests; `name` is the optional friendly name the caller passed to
 * `exposePort()` and is preserved across container restarts.
 */
export type PortTokenEntry = {
  token: string;
  name?: string;
};

export type PreviewPortActivation = RuntimeScoped<{
  token: string;
}>;

export type PreviewPortActivations = Record<string, PreviewPortActivation>;

export type CurrentPreviewPort = {
  port: number;
  entry: PortTokenEntry;
};

export type PreviewStateStorage = Pick<
  DurableObjectStorage | DurableObjectTransaction,
  'get' | 'put' | 'delete'
>;

export const PORT_TOKENS_STORAGE_KEY = 'portTokens';
export const ACTIVE_PREVIEW_PORTS_STORAGE_KEY = 'activePreviewPorts';

/**
 * Read the `portTokens` map from DO storage, normalizing the legacy
 * string-valued format (just a token) to the current object format
 * ({ token, name? }). The legacy format predates port-name persistence and
 * can appear on any DO whose storage was written before that change.
 */
export async function readPortTokens(
  storage: PreviewStateStorage
): Promise<Record<string, PortTokenEntry>> {
  const raw =
    (await storage.get<Record<string, string | PortTokenEntry>>(
      PORT_TOKENS_STORAGE_KEY
    )) ?? {};
  const normalized: Record<string, PortTokenEntry> = {};
  for (const [port, value] of Object.entries(raw)) {
    normalized[port] = typeof value === 'string' ? { token: value } : value;
  }
  return normalized;
}

export async function readActivePreviewPorts(
  storage: PreviewStateStorage
): Promise<PreviewPortActivations> {
  return (
    (await storage.get<PreviewPortActivations>(
      ACTIVE_PREVIEW_PORTS_STORAGE_KEY
    )) ?? {}
  );
}

export async function writeActivePreviewPorts(
  activations: PreviewPortActivations,
  storage: PreviewStateStorage
): Promise<void> {
  if (Object.keys(activations).length === 0) {
    await storage.delete(ACTIVE_PREVIEW_PORTS_STORAGE_KEY);
    return;
  }

  await storage.put(ACTIVE_PREVIEW_PORTS_STORAGE_KEY, activations);
}

export async function readPreviewState(storage: PreviewStateStorage): Promise<{
  tokens: Record<string, PortTokenEntry>;
  activations: PreviewPortActivations;
}> {
  const [tokens, activations] = await Promise.all([
    readPortTokens(storage),
    readActivePreviewPorts(storage)
  ]);
  return { tokens, activations };
}

export async function clearActivePreviewPorts(
  storage: PreviewStateStorage
): Promise<void> {
  await storage.delete(ACTIVE_PREVIEW_PORTS_STORAGE_KEY);
}
