import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { SessionManager } from '@sandbox-container/services/session-manager';
import type { Session } from '@sandbox-container/session';

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
    (mockSessionManager.createSession as any).mockResolvedValue({
      success: true,
      data: {} as Session
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
    (mockSessionManager.createSession as any).mockResolvedValue({
      success: true,
      data: {} as Session
    });

    const api = buildApi(mockSessionManager);
    const result = await api.utils.createSession({ id: 'sess-2' });

    expect(result.containerPlacementId).toBeNull();
  });

  it('includes containerPlacementId in error context on SESSION_ALREADY_EXISTS', async () => {
    process.env.CLOUDFLARE_PLACEMENT_ID = 'placement-rpc-already';
    (mockSessionManager.createSession as any).mockResolvedValue({
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
    (mockSessionManager.createSession as any).mockResolvedValue({
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

describe('SandboxControlAPI tunnels.ensureTunnelRun and stopTunnelRun', () => {
  it('exposes ensureTunnelRun on the tunnels sub-stub', () => {
    const api = buildApi({} as unknown as SessionManager);
    expect(typeof api.tunnels.ensureTunnelRun).toBe('function');
  });

  it('exposes stopTunnelRun on the tunnels sub-stub', () => {
    const api = buildApi({} as unknown as SessionManager);
    expect(typeof api.tunnels.stopTunnelRun).toBe('function');
  });
});
