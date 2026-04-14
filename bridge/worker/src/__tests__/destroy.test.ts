import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

describe('DELETE /v1/sandbox/:id', () => {
  const env = createMockEnv();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls destroy() and returns 204', async () => {
    const res = await app.request(`${BASE}/v1/sandbox/test`, { method: 'DELETE' }, env);
    expect(res.status).toBe(204);
    expect(mockSandbox.destroy).toHaveBeenCalled();
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('returns 204 even when destroy() throws', async () => {
    mockSandbox.destroy.mockRejectedValueOnce(new Error('gone'));
    const res = await app.request(`${BASE}/v1/sandbox/test`, { method: 'DELETE' }, env);
    expect(res.status).toBe(204);
  });

  it('releases pool assignment via reportStopped', async () => {
    const res = await app.request(`${BASE}/v1/sandbox/test`, { method: 'DELETE' }, env);
    expect(res.status).toBe(204);
    expect(env._poolStub.reportStopped).toHaveBeenCalledWith('test');
  });

  it('returns 204 without destroying when sandbox has no assignment', async () => {
    env._poolStub.lookupContainer.mockResolvedValueOnce(null);
    const res = await app.request(`${BASE}/v1/sandbox/test`, { method: 'DELETE' }, env);
    expect(res.status).toBe(204);
    expect(mockSandbox.destroy).not.toHaveBeenCalled();
  });

  it('requires auth when SANDBOX_API_KEY is set', async () => {
    const authEnv = createMockEnv({ SANDBOX_API_KEY: 'secret' });
    const res = await app.request(`${BASE}/v1/sandbox/test`, { method: 'DELETE' }, authEnv);
    expect(res.status).toBe(401);
  });

  it('rejects invalid sandbox ID', async () => {
    const res = await app.request(`${BASE}/v1/sandbox/INVALID`, { method: 'DELETE' }, env);
    expect(res.status).toBe(400);
  });
});
