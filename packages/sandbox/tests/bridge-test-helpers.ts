/**
 * Test helpers for the bridge RPC + bridge-client tests.
 *
 * These tests drive `handleRpcUpgrade()` directly (no Hono routing
 * involved), so the helpers cover only what's needed for that path:
 * a duck-typed `BridgeSandbox` mock and a minimal `BridgeEnv`. The
 * mock is intentionally typed loosely so individual tests can stub
 * arbitrary methods on `mockSandbox` and the session it returns.
 */

import { type Mock, vi } from 'vitest';

type AnyFn = Mock<any>;

export interface MockSandbox {
  getSession: AnyFn;
  // Arbitrary additional methods may be stubbed per test.
  [key: string]: unknown;
}

const isoNow = () => new Date().toISOString();

/**
 * Creates a duck-typed `BridgeSandbox` mock with the methods the bridge
 * RPC shim is most likely to touch. Tests override individual methods
 * via `(mockSandbox as any).METHOD = vi.fn(...)` or by replacing the
 * value `getSession` resolves to.
 */
export function createMockSandbox(): MockSandbox {
  return {
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      exec: vi.fn(async () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
        success: true,
        command: '',
        timestamp: isoNow()
      })),
      execStream: vi.fn(async () => new ReadableStream<Uint8Array>())
    })),
    exec: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      success: true,
      command: '',
      timestamp: isoNow()
    })),
    readFile: vi.fn(async () => ({
      content: '',
      path: '',
      success: true,
      timestamp: isoNow()
    })),
    readFileStream: vi.fn(async () => new ReadableStream<Uint8Array>()),
    writeFile: vi.fn(async () => ({
      success: true,
      path: '',
      timestamp: isoNow()
    })),
    terminal: vi.fn(async () => new Response(null, { status: 200 })),
    createSession: vi.fn(async (opts?: { id?: string }) => ({
      id: opts?.id || 'auto-session-id'
    })),
    deleteSession: vi.fn(async (sessionId: string) => ({
      success: true,
      sessionId,
      timestamp: isoNow()
    })),
    mountBucket: vi.fn(async () => {}),
    unmountBucket: vi.fn(async () => {}),
    destroy: vi.fn(async () => {})
  };
}

/** Mock `BridgeEnv` with optional `SANDBOX_API_KEY` and a Sandbox DO stub. */
export function createMockEnv(
  overrides?: Partial<{ SANDBOX_API_KEY: string }>
) {
  return {
    SANDBOX_API_KEY: overrides?.SANDBOX_API_KEY ?? '',
    Sandbox: { idFromName: vi.fn(), get: vi.fn() }
  };
}
