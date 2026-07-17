// biome-ignore-all lint/complexity/useLiteralKeys: private method/property access in tests

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from './room';
import type { ServerMessage } from './types/protocol';

// Mock cloudflare:workers DurableObject base class
vi.mock('cloudflare:workers', () => {
  return {
    DurableObject: class {
      constructor(
        public ctx: DurableObjectState,
        public env: Env
      ) {}
    },
    RpcTarget: class {},
    WorkerEntrypoint: class {},
    DurableObjectState: class {}
  };
});

let mockCreateTerminalCount = 0;
let mockTerminateCount = 0;

interface MockTerminal {
  id: string;
  status: string;
  getSnapshot: () => Promise<{
    id: string;
    status: string;
    command: readonly string[];
  }>;
  terminate: () => Promise<void>;
}

const mockTerminals = new Map<string, MockTerminal>();

// Mock @cloudflare/sandbox
vi.mock('@cloudflare/sandbox', () => {
  return {
    getSandbox: vi.fn().mockImplementation((_ns: unknown, id: string) => {
      return {
        id,
        createTerminal: async (options: { command: readonly string[] }) => {
          mockCreateTerminalCount++;
          const termId = `term-${crypto.randomUUID().slice(0, 8)}`;
          const t: MockTerminal = {
            id: termId,
            status: 'running',
            getSnapshot: async () => ({
              id: termId,
              status: mockTerminals.get(termId)?.status ?? 'running',
              command: options.command
            }),
            terminate: async () => {
              mockTerminateCount++;
            }
          };
          mockTerminals.set(termId, t);
          return t;
        },
        getTerminal: async (termId: string) => {
          return mockTerminals.get(termId) ?? null;
        }
      };
    })
  };
});

describe('Collaborative Room Terminal Recovery & Lifecycle', () => {
  let mockStorage: Map<string, unknown>;
  let mockCtx: DurableObjectState;
  let mockRegistry: {
    updateRoom: ReturnType<typeof vi.fn>;
    unregisterRoom: ReturnType<typeof vi.fn>;
  };
  let mockEnv: Env;

  beforeEach(() => {
    mockCreateTerminalCount = 0;
    mockTerminateCount = 0;
    mockTerminals.clear();

    mockStorage = new Map<string, unknown>();
    mockCtx = {
      storage: {
        get: vi
          .fn()
          .mockImplementation(async (key: string) => mockStorage.get(key)),
        put: vi.fn().mockImplementation(async (key: string, val: unknown) => {
          mockStorage.set(key, val);
        }),
        deleteAlarm: vi.fn(),
        setAlarm: vi.fn()
      },
      waitUntil: vi.fn()
    } as unknown as DurableObjectState;

    mockRegistry = {
      updateRoom: vi.fn(),
      unregisterRoom: vi.fn()
    };

    mockEnv = {
      Sandbox: {},
      RoomRegistry: {
        idFromName: vi.fn().mockReturnValue('registry-global-id'),
        get: vi.fn().mockReturnValue(mockRegistry)
      }
    } as unknown as Env;
  });

  it('coalesces concurrent room initialization to create only one terminal', async () => {
    const room = new Room(mockCtx, mockEnv);

    // Call ensureRoom concurrently
    const p1 = room['ensureRoom']('123');
    const p2 = room['ensureRoom']('123');
    await Promise.all([p1, p2]);

    // Assert that createTerminal was called exactly once
    expect(mockCreateTerminalCount).toBe(1);
    expect(room['terminalId']).toBeTruthy();
  });

  it('detects and recreates terminal when a stored terminal ID is stale', async () => {
    const room = new Room(mockCtx, mockEnv);

    // Seed a stale terminalId in storage
    mockStorage.set('terminalId', 'stale-term-id');
    // Note: mockTerminals is empty, so getTerminal returns null (stale)

    await room['ensureRoom']('123');

    // Expect a new terminal was created because the stored one was stale
    expect(mockCreateTerminalCount).toBe(1);
    expect(mockStorage.get('terminalId')).not.toBe('stale-term-id');
    expect(room['terminalId']).toBeTruthy();
  });

  it('detects and recreates terminal when stored terminal has exited/errored', async () => {
    const room = new Room(mockCtx, mockEnv);

    // Pre-create a terminal in the mock map but set its status to 'exited'
    const staleId = 'stale-exited-id';
    mockTerminals.set(staleId, {
      id: staleId,
      status: 'exited',
      getSnapshot: async () => ({
        id: staleId,
        status: 'exited',
        command: ['bash']
      }),
      terminate: async () => {
        mockTerminateCount++;
      }
    });
    mockStorage.set('terminalId', staleId);

    await room['ensureRoom']('123');

    expect(mockCreateTerminalCount).toBe(1);
    expect(mockStorage.get('terminalId')).not.toBe(staleId);
    expect(room['terminalId']).toBeTruthy();
  });

  it('reuses valid running terminal if present in storage', async () => {
    const room = new Room(mockCtx, mockEnv);

    // Pre-create a valid terminal in mock map and set status to 'running'
    const validId = 'valid-running-id';
    mockTerminals.set(validId, {
      id: validId,
      status: 'running',
      getSnapshot: async () => ({
        id: validId,
        status: 'running',
        command: ['bash']
      }),
      terminate: async () => {
        mockTerminateCount++;
      }
    });
    mockStorage.set('terminalId', validId);

    await room['ensureRoom']('123');

    expect(mockCreateTerminalCount).toBe(0);
    expect(mockStorage.get('terminalId')).toBe(validId);
    expect(room['terminalId']).toBe(validId);
  });

  it('proves replacement metadata reaches an already-connected client', async () => {
    const room = new Room(mockCtx, mockEnv);

    // Seed storage with firstId
    const firstId = 'term-1';
    mockStorage.set('terminalId', firstId);

    // Pre-create the running terminal in mock map
    mockTerminals.set(firstId, {
      id: firstId,
      status: 'running',
      getSnapshot: async () => ({
        id: firstId,
        status: mockTerminals.get(firstId)!.status,
        command: ['bash']
      }),
      terminate: async () => {
        mockTerminateCount++;
      }
    });
    await room['ensureRoom']('123');
    expect(room['terminalId']).toBe(firstId);
    expect(mockCreateTerminalCount).toBe(0); // It was reused

    // Simulate an already-connected socket inside the room's clients map
    const mockSocket = {
      readyState: 1, // WebSocket.OPEN
      send: vi.fn(),
      addEventListener: vi.fn()
    } as unknown as WebSocket;

    room['clients'].set('user-1', {
      socket: mockSocket,
      user: { id: 'user-1', name: 'Alice', color: '#f97316' }
    });

    // Simulate that terminal-1 has died/exited in the container
    mockTerminals.get(firstId)!.status = 'exited';

    // Subsequent connection admission triggers ensureRoom()
    await room['ensureRoom']('123');

    // Verify that the new terminal was created
    expect(mockCreateTerminalCount).toBe(1);
    const secondId = room['terminalId'];
    expect(secondId).not.toBe(firstId);

    // Verify that Client 1's mock socket received the replacement broadcast
    expect(mockSocket.send).toHaveBeenCalledTimes(1);
    const sentMsg = JSON.parse(
      (mockSocket.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    ) as ServerMessage;
    if (sentMsg.type === 'connected') {
      expect(sentMsg.room.terminalId).toBe(secondId);
    } else {
      expect.fail('Expected connected message type');
    }
  });

  it('terminates terminal on room deletion', async () => {
    const room = new Room(mockCtx, mockEnv);

    // Establish room and terminal first
    await room['ensureRoom']('123');
    expect(mockCreateTerminalCount).toBe(1);

    // Call DELETE to trigger deletion teardown
    const delRes = await room.fetch(
      new Request('http://localhost/api/room/123', {
        method: 'DELETE'
      })
    );

    expect(delRes.status).toBe(204);
    expect(mockTerminateCount).toBe(1);
    expect(mockRegistry.unregisterRoom).toHaveBeenCalledWith('123');
  });

  it('tolerates missing/stale terminal on room deletion', async () => {
    const room = new Room(mockCtx, mockEnv);

    mockStorage.set('terminalId', 'missing-on-delete-id');
    // Note: getTerminal for 'missing-on-delete-id' returns null (missing)

    const delRes = await room.fetch(
      new Request('http://localhost/api/room/123', {
        method: 'DELETE'
      })
    );

    expect(delRes.status).toBe(204);
    expect(mockTerminateCount).toBe(0); // Harmlessly skips terminate but unregisters
    expect(mockRegistry.unregisterRoom).toHaveBeenCalledWith('123');
  });

  it('returns 400 Bad Request if roomId is missing', async () => {
    const room = new Room(mockCtx, mockEnv);

    const wsRes = await room.fetch(
      new Request('http://localhost/ws/room?name=Alice', {
        headers: { Upgrade: 'websocket' }
      })
    );
    expect(wsRes.status).toBe(400);

    const delRes = await room.fetch(
      new Request('http://localhost/api/room/', {
        method: 'DELETE'
      })
    );
    expect(delRes.status).toBe(400);
  });
});
