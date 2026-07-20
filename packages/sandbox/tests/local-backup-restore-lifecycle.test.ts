import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupRestoreOperationRecord } from '../src/backup/restore-operation-store';
import type { ContainerControlClient } from '../src/container-control';
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError
} from '../src/errors';
import { Sandbox } from '../src/sandbox';
import {
  asSandboxWithClient,
  createMockControlClient
} from './helpers/mock-control-client';

vi.mock('@cloudflare/containers', () => {
  class MockContainer {
    ctx: DurableObjectState<{}>;
    env: unknown;

    constructor(ctx: DurableObjectState<{}>, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    async getState(): Promise<{ status: string }> {
      return { status: 'healthy' };
    }

    async startAndWaitForPorts(): Promise<void> {}
  }

  return {
    Container: MockContainer,
    ContainerProxy: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

type StoredValue = unknown;

function createStorage(
  initial = new Map<string, StoredValue>(),
  hooks?: { onPut?: (key: string, value: StoredValue) => void }
) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: StoredValue) => {
      initial.set(key, value);
      hooks?.onPut?.(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      initial.delete(key);
    }),
    list: vi.fn(async () => new Map<string, StoredValue>())
  } as unknown as DurableObjectStorage;
}

function createDisposedRPCError(): RPCTransportError {
  return new RPCTransportError({
    code: ErrorCode.RPC_TRANSPORT_ERROR,
    message: 'RPC session was shut down by disposing the main stub',
    httpStatus: 503,
    context: {
      kind: 'session_disposed',
      originalMessage: 'RPC session was shut down by disposing the main stub',
      errorName: 'Error'
    },
    timestamp: '2026-06-15T12:00:00.000Z'
  });
}

function createMockR2Bucket() {
  const store = new Map<string, { data: ArrayBuffer; size: number }>();
  return {
    put: vi.fn(async (key: string, data: string | ArrayBuffer | Uint8Array) => {
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else if (data instanceof Uint8Array) {
        bytes = new Uint8Array(data);
      } else {
        bytes = new Uint8Array(data);
      }
      store.set(key, {
        data: bytes.buffer as ArrayBuffer,
        size: bytes.byteLength
      });
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        json: async <T>() =>
          JSON.parse(new TextDecoder().decode(entry.data)) as T,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(entry.data));
            controller.close();
          }
        })
      };
    }),
    head: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return { size: entry.size };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ objects: [], truncated: false }))
  };
}

function installClientBackedRuntimeCalls(sandbox: Sandbox): void {
  const target = sandbox as unknown as {
    client: ContainerControlClient;
    runLegacyRuntimeCall<T>(
      operation: string,
      call: (control: ContainerControlClient) => Promise<T>
    ): Promise<T>;
  };
  target.runLegacyRuntimeCall = async (_operation, call) =>
    await call(target.client);
}

async function createLocalRestoreSandbox(params?: {
  storageHooks?: { onPut?: (key: string, value: StoredValue) => void };
}) {
  const storageMap = new Map<string, StoredValue>();
  storageMap.set('currentRuntimeIdentity', {
    schemaVersion: 1,
    id: 'runtime-1',
    runtimeIncarnationID: 'incarnation-1'
  });
  storageMap.set('sandbox:lifetime', {
    id: 'lifetime-1',
    generation: 1,
    createdAt: '2026-06-15T12:00:00.000Z',
    updatedAt: '2026-06-15T12:00:00.000Z'
  });

  const bucket = createMockR2Bucket();
  const backupId = '12345678-1234-1234-1234-123456789012';
  await bucket.put(
    `backups/${backupId}/meta.json`,
    JSON.stringify({
      id: backupId,
      dir: '/workspace/project',
      sizeBytes: 4,
      ttl: 31_536_000,
      createdAt: '2026-06-15T12:00:00.000Z'
    })
  );
  await bucket.put(
    `backups/${backupId}/data.sqsh`,
    new Uint8Array([0x68, 0x73, 0x71, 0x73])
  );

  const ctx = {
    storage: createStorage(storageMap, params?.storageHooks),
    blockConcurrencyWhile: vi.fn(<T>(callback: () => Promise<T>) => callback()),
    waitUntil: vi.fn(),
    id: {
      toString: () => 'test-sandbox-id',
      equals: vi.fn(),
      name: 'test-sandbox'
    },
    container: { running: true }
  } as unknown as DurableObjectState<{}>;

  const sandbox = new Sandbox(ctx, { BACKUP_BUCKET: bucket });
  await vi.waitFor(() => {
    expect(ctx.blockConcurrencyWhile).toHaveBeenCalled();
  });

  const sandboxWithClient = asSandboxWithClient(sandbox);
  sandboxWithClient.client = createMockControlClient();
  installClientBackedRuntimeCalls(sandboxWithClient);
  vi.spyOn(
    (
      sandbox as unknown as {
        runtimeRunner: {
          runWaking<T>(
            operation: string,
            call: (lease: {
              runtime: { id: string; runtimeIncarnationID: string };
              control: ContainerControlClient;
              retain(): { release(): void };
            }) => Promise<T>
          ): Promise<T>;
        };
      }
    ).runtimeRunner,
    'runWaking'
  ).mockImplementation(async (_operation, call) =>
    call({
      runtime: {
        id: 'runtime-1',
        runtimeIncarnationID: 'incarnation-1'
      },
      control: sandboxWithClient.client,
      retain: () => ({ release: () => {} })
    })
  );

  return { sandbox, storageMap, backupId };
}

describe('local backup restore lifecycle', () => {
  it('writes a verified operation record after local restore succeeds', async () => {
    const { sandbox, storageMap, backupId } = await createLocalRestoreSandbox();

    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project',
      localBucket: true
    });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record).toMatchObject({
      kind: 'backup.restore',
      status: 'committed',
      phase: 'verified',
      runtimeIdentityID: 'runtime-1',
      runtimeIncarnationID: 'incarnation-1',
      payload: {
        backupId,
        dir: '/workspace/project',
        archiveSize: 4
      },
      result
    });
  });

  it('records the supplied runtime without marking a new one', async () => {
    const writes: string[] = [];
    const { sandbox, backupId } = await createLocalRestoreSandbox({
      storageHooks: { onPut: (key) => writes.push(key) }
    });

    await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project',
      localBucket: true
    });

    expect(writes).not.toContain('currentRuntimeIdentity');
  });

  it('does not mark the local archive ready before stream upload completes', async () => {
    const { sandbox, storageMap, backupId } = await createLocalRestoreSandbox();
    vi.spyOn(
      asSandboxWithClient(sandbox).client.files,
      'writeFileStream'
    ).mockImplementationOnce(async () => {
      const record = storageMap.get(
        `operations:restore:${backupId}:/workspace/project`
      ) as BackupRestoreOperationRecord;
      expect(record.phase).toBe('runtime_ready');
      return {
        success: true,
        path: `/var/backups/${backupId}.sqsh`,
        bytesWritten: 4,
        timestamp: '2026-06-15T12:00:00.000Z'
      } as never;
    });

    await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project',
      localBucket: true
    });
  });

  it('does not replay local archive streaming after transport loss', async () => {
    const { sandbox, storageMap, backupId } = await createLocalRestoreSandbox();
    const writeFileStreamSpy = vi
      .spyOn(asSandboxWithClient(sandbox).client.files, 'writeFileStream')
      .mockRejectedValueOnce(createDisposedRPCError())
      .mockResolvedValueOnce({
        success: true,
        path: `/var/backups/${backupId}.sqsh`,
        bytesWritten: 4,
        timestamp: '2026-06-15T12:00:00.000Z'
      });

    await expect(
      sandbox.restoreBackup({
        id: backupId,
        dir: '/workspace/project',
        localBucket: true
      })
    ).rejects.toBeInstanceOf(OperationInterruptedError);

    expect(writeFileStreamSpy).toHaveBeenCalledTimes(1);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
  });
});
