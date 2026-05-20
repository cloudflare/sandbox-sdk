const DEFAULT_STOP_SETTLED_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_POLL_INTERVAL_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type ContainerStateResponse = { status?: unknown };

type StopContainerAndWaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
};

function isActiveContainerStatus(status: string): boolean {
  return status === 'healthy' || status === 'running';
}

async function responseText(response: Response): Promise<string> {
  return await response.text().catch(() => '<unreadable>');
}

export async function getContainerStatus(
  workerUrl: string,
  headers: Record<string, string>,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<string> {
  const response = await fetch(`${workerUrl}/api/state`, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(
      `Failed to read container state: ${response.status} ${await responseText(response)}`
    );
  }

  const state = (await response.json()) as ContainerStateResponse;
  if (typeof state.status !== 'string') {
    throw new Error(`Container state response did not include a status`);
  }

  return state.status;
}

/**
 * `stop()` requests graceful shutdown; it is not a lifecycle barrier. Tests
 * that need a completed runtime boundary should call this helper instead of
 * assuming the stop request has fully settled before the next SDK operation.
 */
export async function stopContainerAndWait(
  workerUrl: string,
  headers: Record<string, string>,
  options: StopContainerAndWaitOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_SETTLED_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const stopResponse = await fetch(`${workerUrl}/api/container/stop`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!stopResponse.ok) {
    throw new Error(
      `Failed to stop container: ${stopResponse.status} ${await responseText(stopResponse)}`
    );
  }

  const deadline = Date.now() + timeoutMs;
  let lastStatus = await getContainerStatus(
    workerUrl,
    headers,
    requestTimeoutMs
  );

  while (Date.now() < deadline) {
    if (!isActiveContainerStatus(lastStatus)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    lastStatus = await getContainerStatus(workerUrl, headers, requestTimeoutMs);
  }

  throw new Error(
    `Timed out waiting ${timeoutMs}ms for container to stop; last status: ${lastStatus}`
  );
}
