import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutorEnvironment } from '../src/executor-environment';
import type { OpenAISession } from '../src/openai-session';
import {
  resetSpanAttributes,
  spanAttributes
} from './mocks/cloudflare-workers';

class FakeStorage {
  data = new Map<string, unknown>();
  alarm: number | undefined;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.alarm = undefined;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }
}

function openAISession(
  overrides: {
    status?: OpenAISession['status'];
    agentID?: string;
    environmentType?: string;
    environmentID?: string;
    remoteURL?: string;
    requiredActions?: Array<{ type: string; environment_id?: string }>;
  } = {}
) {
  const environmentID = overrides.environmentID ?? 'env_1';
  return {
    status: overrides.status ?? 'requires_action',
    agent: { id: overrides.agentID ?? 'agent_1' },
    environment: {
      type: overrides.environmentType ?? 'self_hosted',
      id: environmentID,
      ...(overrides.remoteURL === undefined
        ? { remote_url: 'https://api.openai.test/v1/agents/api' }
        : overrides.remoteURL
          ? { remote_url: overrides.remoteURL }
          : {})
    },
    required_actions: overrides.requiredActions ?? [
      { type: 'environment_connection', environment_id: environmentID }
    ]
  };
}

function executorFixture(
  options: {
    running?: boolean;
    keepAliveSeconds?: string;
    snapshotsEnabled?: string;
    prewarmEnabled?: string;
  } = {}
) {
  const storage = new FakeStorage();
  const monitorRejectors: Array<(error: Error) => void> = [];
  const container = {
    running: options.running ?? false,
    start: vi.fn(function (this: { running: boolean }) {
      this.running = true;
    }),
    destroy: vi.fn(async function (this: { running: boolean }) {
      this.running = false;
    }),
    monitor: vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          monitorRejectors.push(reject);
        })
    ),
    setInactivityTimeout: vi.fn(async (): Promise<void> => undefined),
    snapshotContainer: vi.fn(async () => ({
      id: 'snapshot_1',
      size: 1,
      name: 'sess_1'
    }))
  };
  const ctx = { storage, container } as unknown as DurableObjectState;
  const env = {
    OPENAI_EXECUTOR_API_KEY: 'executor-key',
    EXECUTOR_CLIENT_SECRET: 'executor-client-secret',
    EXECUTOR_KEEP_ALIVE_SECONDS: options.keepAliveSeconds ?? '30',
    EXECUTOR_PREWARM_ENABLED: options.prewarmEnabled ?? 'true',
    EXECUTOR_SNAPSHOTS_ENABLED: options.snapshotsEnabled ?? 'true',
    OPENAI_API_KEY: 'controller-key',
    OPENAI_AGENT_ID: 'agent_1'
  } as unknown as Env;
  return {
    storage,
    container,
    env,
    rejectMonitor(error: Error, index = 0) {
      container.running = false;
      const reject = monitorRejectors[index];
      if (!reject)
        throw new Error(`Container monitor ${index} is not attached.`);
      reject(error);
    },
    executor: new ExecutorEnvironment(ctx, env)
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetSpanAttributes();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(openAISession()))
  );
});

describe('ExecutorEnvironment connection lifecycle', () => {
  it('starts from fresh action-required connection state', async () => {
    const { storage, container, executor } = executorFixture();
    const before = Date.now();

    await executor.update('sess_1');

    expect(container.start).toHaveBeenCalledWith({
      enableInternet: true,
      env: {
        CODEX_API_KEY: 'executor-key',
        OPENAI_ENVIRONMENT_ID: 'env_1',
        OPENAI_REMOTE_URL: 'https://api.openai.test/v1/agents/api',
        HOME: '/root',
        USER: 'root',
        LOGNAME: 'root',
        LANG: 'C.UTF-8'
      }
    });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(30_000);
    await expect(storage.get('sessionID')).resolves.toBe('sess_1');
    await expect(storage.get('environmentID')).resolves.toBe('env_1');
    expect(storage.alarm).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('handles environment connection through the required-actions loop', async () => {
    const { container, executor } = executorFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          openAISession({
            requiredActions: [
              { type: 'function_call' },
              { type: 'environment_connection', environment_id: 'env_2' }
            ]
          })
        )
      )
    );

    await executor.update('sess_1');

    expect(container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ OPENAI_ENVIRONMENT_ID: 'env_2' })
      })
    );
  });

  it('rejects action-required state without a remote URL', async () => {
    const { container, executor } = executorFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(openAISession({ remoteURL: '' })))
    );

    await expect(executor.update('sess_1')).rejects.toThrow('remote_url');
    expect(container.start).not.toHaveBeenCalled();
  });

  it('prewarms from created session state', async () => {
    const { container, executor } = executorFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          openAISession({
            status: 'idle',
            environmentID: 'env_created',
            remoteURL: 'https://created.example.test/v1',
            requiredActions: []
          })
        )
      )
    );

    await executor.prewarm('sess_1');

    expect(container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_ENVIRONMENT_ID: 'env_created',
          OPENAI_REMOTE_URL: 'https://created.example.test/v1'
        })
      })
    );
  });

  it('rejects created session state without connection details', async () => {
    const { container, executor } = executorFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          openAISession({
            status: 'idle',
            remoteURL: '',
            requiredActions: []
          })
        )
      )
    );

    await expect(executor.prewarm('sess_1')).rejects.toThrow(
      'connection details'
    );
    expect(container.start).not.toHaveBeenCalled();
  });

  it('can disable created-event prewarming', async () => {
    const { container, executor } = executorFixture({
      prewarmEnabled: 'false'
    });

    await executor.prewarm('sess_1');

    expect(fetch).not.toHaveBeenCalled();
    expect(container.start).not.toHaveBeenCalled();
  });

  it('does not prewarm a session owned by another agent', async () => {
    const { container, executor } = executorFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(openAISession({ agentID: 'agent_other' }))
      )
    );

    await executor.prewarm('sess_1');

    expect(container.start).not.toHaveBeenCalled();
  });

  it('reuses a running executor for the same environment', async () => {
    const { container, executor } = executorFixture();

    await executor.update('sess_1');
    await executor.update('sess_1');

    expect(container.start).toHaveBeenCalledOnce();
    expect(container.destroy).not.toHaveBeenCalled();
    expect(container.setInactivityTimeout).toHaveBeenCalledTimes(2);
  });

  it('adopts a running Container when its environment metadata is absent', async () => {
    const { storage, container, executor } = executorFixture({ running: true });

    await executor.update('sess_1');

    expect(container.destroy).not.toHaveBeenCalled();
    expect(container.start).not.toHaveBeenCalled();
    expect(container.monitor).toHaveBeenCalledOnce();
    await expect(storage.get('environmentID')).resolves.toBe('env_1');
  });

  it('replaces a running Container for a changed environment', async () => {
    const { storage, container, executor } = executorFixture({ running: true });
    await storage.put('environmentID', 'env_old');

    await executor.update('sess_1');

    expect(container.destroy).toHaveBeenCalledOnce();
    expect(container.start).toHaveBeenCalledOnce();
    expect(container.snapshotContainer).not.toHaveBeenCalled();
  });

  it('continues queued operations after an update fails', async () => {
    const { container, executor } = executorFixture();
    container.setInactivityTimeout.mockRejectedValueOnce(
      new Error('timeout unavailable')
    );

    await expect(executor.update('sess_1')).rejects.toThrow(
      'timeout unavailable'
    );
    await executor.update('sess_1');

    expect(container.start).toHaveBeenCalledOnce();
  });
});

describe('ExecutorEnvironment deadline', () => {
  it('re-arms one deadline for a running Container', async () => {
    const { storage, container, executor } = executorFixture({ running: true });
    const before = Date.now();

    await executor.update('sess_1');

    expect(container.setInactivityTimeout).toHaveBeenCalledWith(30_000);
    await expect(storage.get('sessionID')).resolves.toBe('sess_1');
    expect(storage.alarm).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('starts a missing Container from in-progress session state', async () => {
    const { storage, container, executor } = executorFixture();

    await executor.update('sess_1');

    expect(container.start).toHaveBeenCalledOnce();
    await expect(storage.get('sessionID')).resolves.toBe('sess_1');
    expect(storage.alarm).toBeDefined();
  });

  it('re-arms when the deadline finds an active session', async () => {
    const { storage, container, executor } = executorFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(openAISession({ status: 'in_progress' })))
    );
    await executor.update('sess_1');
    container.setInactivityTimeout.mockClear();
    const before = Date.now();

    await executor.alarm();

    expect(container.destroy).not.toHaveBeenCalled();
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(30_000);
    expect(storage.alarm).toBeGreaterThanOrEqual(before + 30_000);
    expect(spanAttributes).toContainEqual([
      'openai.session_status',
      'in_progress'
    ]);
  });

  it('marks a deadline without session state as an error', async () => {
    const { executor } = executorFixture();

    await executor.alarm();

    expect(spanAttributes).toContainEqual(['error', true]);
    expect(spanAttributes).toContainEqual([
      'error.message',
      'Executor deadline is missing a session ID.'
    ]);
  });

  it('re-arms after an OpenAI lookup failure', async () => {
    const { storage, container, executor } = executorFixture();
    await executor.update('sess_1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );
    const before = Date.now();

    await expect(executor.alarm()).rejects.toThrow('status 503');

    expect(container.destroy).not.toHaveBeenCalled();
    expect(storage.alarm).toBeGreaterThanOrEqual(before + 30_000);
  });

  it.each(['0', '-1', 'invalid', '9007199254740991'])(
    'rejects invalid keep-alive seconds %s',
    async (keepAliveSeconds) => {
      const { container, executor } = executorFixture({
        keepAliveSeconds,
        running: true
      });

      await expect(executor.update('sess_1')).rejects.toThrow(
        'EXECUTOR_KEEP_ALIVE_SECONDS'
      );
      expect(container.setInactivityTimeout).not.toHaveBeenCalled();
    }
  );
});

describe('ExecutorEnvironment snapshots', () => {
  it('snapshots the whole Container when an idle event is confirmed', async () => {
    const { storage, container, executor } = executorFixture();
    await executor.update('sess_1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(openAISession({ status: 'idle' })))
    );

    await executor.update('sess_1');

    expect(container.snapshotContainer).toHaveBeenCalledWith({});
    await expect(storage.get('containerSnapshot')).resolves.toEqual({
      id: 'snapshot_1',
      size: 1,
      name: 'sess_1'
    });
    expect(spanAttributes).toContainEqual(['container.snapshot.created', true]);
    expect(spanAttributes).toContainEqual([
      'container.snapshot.id',
      'snapshot_1'
    ]);
    expect(spanAttributes).toContainEqual(['container.snapshot.size', 1]);
    expect(container.destroy).not.toHaveBeenCalled();
    expect(storage.alarm).toBeDefined();
  });

  it('destroys idle compute at the deadline without deleting its snapshot', async () => {
    const { storage, container, executor } = executorFixture();
    await executor.update('sess_1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(openAISession({ status: 'idle' })))
    );
    await executor.update('sess_1');
    container.snapshotContainer.mockClear();

    await executor.alarm();

    expect(container.snapshotContainer).not.toHaveBeenCalled();
    expect(container.destroy).toHaveBeenCalledOnce();
    expect(container.setInactivityTimeout).not.toHaveBeenLastCalledWith(0);
    await expect(storage.get('containerSnapshot')).resolves.toEqual({
      id: 'snapshot_1',
      size: 1,
      name: 'sess_1'
    });
    await expect(storage.get('environmentID')).resolves.toBeUndefined();
    await expect(storage.get('sessionID')).resolves.toBeUndefined();
    expect(storage.alarm).toBeUndefined();
  });

  it('allows idle compute to time out without snapshotting when disabled', async () => {
    const { storage, container, executor } = executorFixture({
      snapshotsEnabled: 'false'
    });
    await executor.update('sess_1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(openAISession({ status: 'idle' })))
    );

    await executor.update('sess_1');

    expect(container.snapshotContainer).not.toHaveBeenCalled();
    await expect(storage.get('containerSnapshot')).resolves.toBeUndefined();
    expect(container.destroy).not.toHaveBeenCalled();
    expect(storage.alarm).toBeDefined();
  });

  it('keeps the Container and re-arms after snapshot failure', async () => {
    const { storage, container, executor } = executorFixture();
    await executor.update('sess_1');
    container.snapshotContainer.mockRejectedValueOnce(
      new Error('snapshot unavailable')
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(openAISession({ status: 'idle' })))
    );
    const before = Date.now();

    await expect(executor.update('sess_1')).rejects.toThrow(
      'snapshot unavailable'
    );

    expect(container.destroy).not.toHaveBeenCalled();
    expect(storage.alarm).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('restores the saved whole-Container snapshot on the next start', async () => {
    const { storage, container, executor } = executorFixture();
    await storage.put('containerSnapshot', {
      id: 'snapshot_1',
      size: 1,
      name: 'sess_1'
    });

    await executor.update('sess_1');

    expect(container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        containerSnapshot: {
          id: 'snapshot_1',
          size: 1,
          name: 'sess_1'
        }
      })
    );
    expect(spanAttributes).toContainEqual([
      'container.snapshot.restored',
      true
    ]);
    expect(spanAttributes).toContainEqual([
      'container.snapshot.id',
      'snapshot_1'
    ]);
    expect(spanAttributes).toContainEqual(['container.snapshot.size', 1]);
  });

  it('does not restore a snapshot when snapshots are disabled', async () => {
    const { storage, container, executor } = executorFixture({
      snapshotsEnabled: 'false'
    });
    await storage.put('containerSnapshot', {
      id: 'snapshot_1',
      size: 1,
      name: 'sess_1'
    });

    await executor.update('sess_1');

    expect(container.start).toHaveBeenCalledWith(
      expect.not.objectContaining({ containerSnapshot: expect.anything() })
    );
  });
});

describe('ExecutorEnvironment cleanup and monitoring', () => {
  it('ignores a failed session owned by another agent', async () => {
    const { container, executor } = executorFixture({ running: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          openAISession({ status: 'failed', agentID: 'agent_other' })
        )
      )
    );

    await executor.update('sess_1');

    expect(container.destroy).not.toHaveBeenCalled();
  });

  it('clears snapshots when the session failed', async () => {
    const { storage, container, executor } = executorFixture({ running: true });
    await storage.put('containerSnapshot', { id: 'snapshot_1', size: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(openAISession({ status: 'failed' })))
    );

    await executor.update('sess_1');

    expect(container.destroy).toHaveBeenCalledOnce();
    expect(storage.data.size).toBe(0);
  });

  it('clears snapshots when the session was deleted', async () => {
    const { storage, container, executor } = executorFixture({ running: true });
    await storage.put('containerSnapshot', { id: 'snapshot_1', size: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    );

    await executor.update('sess_1');

    expect(container.destroy).toHaveBeenCalledOnce();
    expect(storage.data.size).toBe(0);
  });

  it('does not treat an intentional destroy as a crash', async () => {
    const { container, executor, rejectMonitor } = executorFixture();
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await executor.update('sess_1');
    container.destroy.mockImplementationOnce(async () => {
      rejectMonitor(
        new Error('Container exited with unexpected exit code: 137')
      );
    });

    await executor.destroy();
    await Promise.resolve();

    expect(container.start).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(errorLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Codex executor crashed' })
    );
  });

  it('restarts after an unexpected crash', async () => {
    const { container, executor, rejectMonitor } = executorFixture();
    await executor.update('sess_1');

    rejectMonitor(new Error('container crashed'));

    await vi.waitFor(() => expect(container.start).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
