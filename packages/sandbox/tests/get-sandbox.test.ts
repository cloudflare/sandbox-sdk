import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSandbox } from '../src/sandbox';

// Mock the Container module
vi.mock('@cloudflare/containers', () => ({
  Container: class Container {
    ctx: any;
    env: any;
    sleepAfter: string | number = '3m';
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  getContainer: vi.fn(),
}));

describe('getSandbox', () => {
  let mockStub: any;
  let mockGetContainer: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create a fresh mock stub for each test
    mockStub = {
      sleepAfter: '3m',
      setSandboxName: vi.fn(),
      setBaseUrl: vi.fn(),
      setSleepAfter: vi.fn((value: string | number) => {
        mockStub.sleepAfter = value;
      }),
    };

    // Mock getContainer to return our stub
    const containers = await import('@cloudflare/containers');
    mockGetContainer = vi.mocked(containers.getContainer);
    mockGetContainer.mockReturnValue(mockStub);
  });

  it('should create a sandbox instance with default sleepAfter', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox');

    expect(sandbox).toBeDefined();
    expect(sandbox.setSandboxName).toHaveBeenCalledWith('test-sandbox');
  });

  it('should apply sleepAfter option when provided as string', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      sleepAfter: '5m',
    });

    expect(sandbox.sleepAfter).toBe('5m');
  });

  it('should apply sleepAfter option when provided as number', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      sleepAfter: 300, // 5 minutes in seconds
    });

    expect(sandbox.sleepAfter).toBe(300);
  });

  it('should apply baseUrl option when provided', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      baseUrl: 'https://example.com',
    });

    expect(sandbox.setBaseUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('should apply both sleepAfter and baseUrl options together', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      sleepAfter: '10m',
      baseUrl: 'https://example.com',
    });

    expect(sandbox.sleepAfter).toBe('10m');
    expect(sandbox.setBaseUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('should not apply sleepAfter when not provided', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox');

    // Should remain default value from Container
    expect(sandbox.sleepAfter).toBe('3m');
  });

  it('should accept various time string formats for sleepAfter', () => {
    const mockNamespace = {} as any;
    const testCases = ['30s', '1m', '10m', '1h', '2h'];

    for (const timeString of testCases) {
      // Reset the mock stub for each iteration
      mockStub.sleepAfter = '3m';

      const sandbox = getSandbox(mockNamespace, `test-sandbox-${timeString}`, {
        sleepAfter: timeString,
      });

      expect(sandbox.sleepAfter).toBe(timeString);
    }
  });
});
