interface DesktopStatus {
  status: 'active' | 'partial' | 'inactive';
  processes: Record<
    string,
    { running: boolean; pid?: number; uptime?: number }
  >;
  resolution: [number, number] | null;
  dpi: number | null;
}
async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  startDesktop: (resolution?: [number, number]) =>
    json<{ success: boolean }>('/api/start', {
      method: 'POST',
      headers: resolution ? { 'Content-Type': 'application/json' } : undefined,
      body: resolution ? JSON.stringify({ resolution }) : undefined
    }),
  stopDesktop: () =>
    json<{ success: boolean }>('/api/stop', { method: 'POST' }),
  getStatus: () => json<DesktopStatus>('/api/status'),
  getStreamUrl: () =>
    json<{ url: string }>('/api/stream-url', { method: 'POST' })
};
