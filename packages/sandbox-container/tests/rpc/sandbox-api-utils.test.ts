import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { SessionManager } from '@sandbox-container/services/session-manager';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

function buildApi(sessionManager: SessionManager): SandboxControlAPI {
  // Domains other than sessionManager are unused by utils.createSession; cast
  // through unknown so the test does not have to construct real services.
  return new SandboxControlAPI({
    sessionManager,
    logger: mockLogger
  } as unknown as SandboxAPIDeps);
}

describe('SandboxControlAPI tunnels.ensureTunnelRun', () => {
  it('exposes the runtime-run control methods only', () => {
    const api = new SandboxControlAPI({
      tunnelService: {},
      logger: mockLogger
    } as unknown as SandboxAPIDeps);

    expect('ensureTunnelRun' in api.tunnels).toBe(true);
    expect('stopTunnelRun' in api.tunnels).toBe(true);
    expect('runQuickTunnel' in api.tunnels).toBe(false);
    expect('runNamedTunnel' in api.tunnels).toBe(false);
    expect('destroyTunnel' in api.tunnels).toBe(false);
  });

  it('delegates to the tunnel service and returns the runtime-run result', async () => {
    const request = {
      mode: 'quick' as const,
      tunnelId: 'quick-1',
      runId: 'run-1',
      port: 8080
    };
    const run = {
      ...request,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com',
      startedAt: '2026-01-01T00:00:00.000Z'
    };
    const ensureTunnelRun = vi.fn(async () => ({
      success: true as const,
      data: { run, started: true }
    }));
    const api = new SandboxControlAPI({
      tunnelService: { ensureTunnelRun },
      logger: mockLogger
    } as unknown as SandboxAPIDeps);

    const result = await api.tunnels.ensureTunnelRun(request);

    expect(ensureTunnelRun).toHaveBeenCalledWith(request);
    expect(result).toEqual({ run, started: true });
  });
});

function mockCreateSessionResult(
  sessionManager: SessionManager,
  result: unknown
): void {
  (
    sessionManager.createSession as unknown as {
      mockResolvedValue(value: unknown): void;
    }
  ).mockResolvedValue(result);
}

describe('SandboxControlAPI utils.createSession', () => {
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionManager = {
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      listSessions: vi.fn()
    } as unknown as SessionManager;
  });

  afterEach(() => {
    delete process.env.CLOUDFLARE_PLACEMENT_ID;
  });

  it('returns containerPlacementId from CLOUDFLARE_PLACEMENT_ID on success', async () => {
    process.env.CLOUDFLARE_PLACEMENT_ID = 'placement-rpc-123';
    mockCreateSessionResult(mockSessionManager, {
      success: true,
      data: {}
    });

    const api = buildApi(mockSessionManager);
    const result = await api.utils.createSession({ id: 'sess-1' });

    expect(result).toMatchObject({
      success: true,
      id: 'sess-1',
      containerPlacementId: 'placement-rpc-123'
    });
    expect(typeof result.timestamp).toBe('string');
  });

  it('returns containerPlacementId: null when CLOUDFLARE_PLACEMENT_ID is unset', async () => {
    delete process.env.CLOUDFLARE_PLACEMENT_ID;
    mockCreateSessionResult(mockSessionManager, {
      success: true,
      data: {}
    });

    const api = buildApi(mockSessionManager);
    const result = await api.utils.createSession({ id: 'sess-2' });

    expect(result.containerPlacementId).toBeNull();
  });

  it('includes containerPlacementId in error context on SESSION_ALREADY_EXISTS', async () => {
    process.env.CLOUDFLARE_PLACEMENT_ID = 'placement-rpc-already';
    mockCreateSessionResult(mockSessionManager, {
      success: false,
      error: {
        message: "Session 'sess-3' already exists",
        code: ErrorCode.SESSION_ALREADY_EXISTS,
        details: { sessionId: 'sess-3' }
      }
    });

    const api = buildApi(mockSessionManager);

    let caught: Error | undefined;
    try {
      await api.utils.createSession({ id: 'sess-3' });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    expect(err.code).toBe(ErrorCode.SESSION_ALREADY_EXISTS);
    expect(err.message).toBe("Session 'sess-3' already exists");
    expect(err.details).toEqual({
      sessionId: 'sess-3',
      containerPlacementId: 'placement-rpc-already'
    });
  });

  it('does not add containerPlacementId to unrelated error codes', async () => {
    process.env.CLOUDFLARE_PLACEMENT_ID = 'placement-should-not-appear';
    mockCreateSessionResult(mockSessionManager, {
      success: false,
      error: {
        message: 'Some other failure',
        code: ErrorCode.UNKNOWN_ERROR,
        details: { foo: 'bar' }
      }
    });

    const api = buildApi(mockSessionManager);

    let caught: Error | undefined;
    try {
      await api.utils.createSession({ id: 'sess-4' });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    expect(err.code).toBe(ErrorCode.UNKNOWN_ERROR);
    expect(err.details).toEqual({ foo: 'bar' });
    expect(err.details?.containerPlacementId).toBeUndefined();
  });
});
