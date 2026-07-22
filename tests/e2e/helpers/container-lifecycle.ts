const DEFAULT_STOP_SETTLED_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_POLL_INTERVAL_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTHY_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTHY_POLL_INTERVAL_MS = 250;

type ContainerStateResponse = { status?: unknown };

type WaitForContainerOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
};

function isStoppedContainerStatus(status: string): boolean {
  return status === 'stopped' || status === 'stopped_with_code';
}

async function responseText(response: Response): Promise<string> {
  return await response.text().catch(() => '<unreadable>');
}

async function waitForContainerStatus(
  workerUrl: string,
  headers: Record<string, string>,
  isExpectedStatus: (status: string) => boolean,
  timeoutMessage: (timeoutMs: number, lastStatus: string) => string,
  options: WaitForContainerOptions
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_SETTLED_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const deadline = Date.now() + timeoutMs;
  let lastStatus = await getContainerStatus(
    workerUrl,
    headers,
    requestTimeoutMs
  );

  while (Date.now() < deadline) {
    if (isExpectedStatus(lastStatus)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    lastStatus = await getContainerStatus(workerUrl, headers, requestTimeoutMs);
  }

  throw new Error(timeoutMessage(timeoutMs, lastStatus));
}

export async function getContainerStatus(
  workerUrl: string,
  headers: Record<string, string>,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<string> {
  // /api/state calls sandbox.getState(), which reads Durable Object-owned
  // container state without starting, probing, or forwarding to the container.
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
 * `stop()` requests graceful shutdown; it is not a lifecycle barrier. This
 * helper waits until the container library reports physical stopped state,
 * but that state does not guarantee the Sandbox `onStop()` hook has run.
 *
 * This intentionally uses the test worker's stop endpoint to force the same
 * stop/replacement boundary users can observe after sleep or runtime exit.
 * The next waking SDK operation must reconcile any delayed stop notification.
 */
export async function waitForContainerStopped(
  workerUrl: string,
  headers: Record<string, string>,
  options: WaitForContainerOptions = {}
): Promise<void> {
  await waitForContainerStatus(
    workerUrl,
    headers,
    isStoppedContainerStatus,
    (timeoutMs, lastStatus) =>
      `Timed out waiting ${timeoutMs}ms for container to stop; last status: ${lastStatus}`,
    options
  );
}

export async function stopContainerAndWait(
  workerUrl: string,
  headers: Record<string, string>,
  options: WaitForContainerOptions = {}
): Promise<void> {
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

  await waitForContainerStopped(workerUrl, headers, options);
}

export async function waitForContainerHealthy(
  workerUrl: string,
  headers: Record<string, string>,
  options: WaitForContainerOptions = {}
): Promise<void> {
  await waitForContainerStatus(
    workerUrl,
    headers,
    (status) => status === 'healthy',
    (timeoutMs, lastStatus) =>
      `Timed out waiting ${timeoutMs}ms for container to become healthy; last status: ${lastStatus}`,
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_HEALTHY_TIMEOUT_MS,
      pollIntervalMs:
        options.pollIntervalMs ?? DEFAULT_HEALTHY_POLL_INTERVAL_MS,
      requestTimeoutMs: options.requestTimeoutMs
    }
  );
}
