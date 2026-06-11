const INSTALL_KEY = Symbol.for(
  'sandbox-sdk.e2e.container-unavailable-fetch-retry'
);

type RetriableFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

type FetchInstallerState = {
  restore: () => void;
};

type FetchRetryOptions = {
  fetchImpl?: RetriableFetch;
  setFetch?: (next: RetriableFetch) => void;
  attempts?: number;
  delayMs?: number;
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 1_000;

export async function isContainerUnavailableResponse(
  response: Response
): Promise<boolean> {
  if (response.status !== 503) return false;

  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return body.code === 'CONTAINER_UNAVAILABLE';
  } catch {
    return false;
  }
}

export function installContainerUnavailableFetchRetry(
  options: FetchRetryOptions = {}
): () => void {
  const globalState = globalThis as typeof globalThis & {
    [INSTALL_KEY]?: FetchInstallerState;
  };
  if (globalState[INSTALL_KEY]) return globalState[INSTALL_KEY].restore;

  const originalFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const setFetch =
    options.setFetch ??
    ((next) => {
      globalThis.fetch = next as typeof fetch;
    });
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  const retryingFetch: RetriableFetch = async (input, init) => {
    const requestAttempts =
      input instanceof Request
        ? Array.from({ length: attempts }, () => input.clone())
        : null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const requestInput = requestAttempts?.[attempt - 1] ?? input;
      const response = await originalFetch(requestInput, init);
      if (!(await isContainerUnavailableResponse(response))) {
        return response;
      }
      if (attempt === attempts) return response;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return originalFetch(input, init);
  };

  const restore = () => {
    setFetch(originalFetch);
    delete globalState[INSTALL_KEY];
  };

  globalState[INSTALL_KEY] = { restore };
  setFetch(retryingFetch);
  return restore;
}
