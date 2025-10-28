import type { DurableObjectState } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';
import { validatePort } from '../src/security';

// Mock dependencies
vi.mock('../src/clients/sandbox-client', () => ({
  SandboxClient: vi.fn(),
}));

vi.mock('../src/interpreter', () => ({
  CodeInterpreter: vi.fn(),
}));

vi.mock('@repo/shared', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
      return new Response('Mock Container fetch');
    }
    async containerFetch(request: Request, port: number): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
  };
});

describe('Control plane port configuration', () => {
  let mockCtx: Partial<DurableObjectState>;
  let mockEnv: any;

  beforeEach(() => {
    mockCtx = {
      id: {
        toString: () => 'test-id',
        equals: vi.fn(),
        name: 'test-sandbox',
      } as any,
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map()),
      } as any,
      blockConcurrencyWhile: vi.fn((fn: () => Promise<void>) => fn()),
      waitUntil: vi.fn(),
    };

    mockEnv = {};
  });

  describe('Sandbox configuration', () => {
    test('should use default port 3000 when not configured', () => {
      const sandbox = new Sandbox(mockCtx as DurableObjectState, mockEnv);
      expect(sandbox.getControlPlanePort()).toBe(3000);
    });

    test('should use configured port from environment', () => {
      mockEnv.SANDBOX_CONTROL_PLANE_PORT = '3001';
      const sandbox = new Sandbox(mockCtx as DurableObjectState, mockEnv);
      expect(sandbox.getControlPlanePort()).toBe(3001);
    });

    test.each([
      ['invalid', 'non-numeric'],
      ['0', 'out of range'],
      ['99999', 'out of range'],
      ['8787', 'reserved port'],
    ])('should throw error for invalid value: %s (%s)', (value) => {
      mockEnv.SANDBOX_CONTROL_PLANE_PORT = value;
      expect(() => {
        new Sandbox(mockCtx as DurableObjectState, mockEnv);
      }).toThrow();
    });
  });

  describe('validatePort with dynamic control plane', () => {
    test('should block configured control plane port', () => {
      expect(validatePort(3000, 3000)).toBe(false);
      expect(validatePort(3001, 3001)).toBe(false);
    });

    test('should allow previous control plane port when changed', () => {
      expect(validatePort(3000, 3001)).toBe(true);
    });

    test('should always block reserved ports', () => {
      expect(validatePort(8787, 3000)).toBe(false);
      expect(validatePort(8787, 3001)).toBe(false);
    });

    test.each([
      [1024, true, 'minimum valid port'],
      [8080, true, 'common user port'],
      [65535, true, 'maximum valid port'],
      [1023, false, 'system port'],
      [0, false, 'invalid port'],
      [65536, false, 'out of range'],
      [3000.5, false, 'non-integer'],
    ])('validatePort(%i) should return %s (%s)', (port, expected) => {
      expect(validatePort(port, 3000)).toBe(expected);
    });

    test('should use default control plane port 3000 when not provided', () => {
      expect(validatePort(3000)).toBe(false);
      expect(validatePort(8080)).toBe(true);
    });
  });
});
