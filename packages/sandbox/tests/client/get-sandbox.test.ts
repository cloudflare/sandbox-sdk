import { describe, expect, it } from 'vitest';
import { getSandbox } from '../../src/client/get-sandbox';
import { BridgeSandboxClient } from '../../src/client/sandbox-client';

describe('getSandbox', () => {
  it('should create BridgeSandboxClient with provided options', () => {
    const sandbox = getSandbox('my-sandbox', {
      baseUrl: 'https://bridge.example.com',
      apiKey: 'test-key'
    });

    expect(sandbox).toBeInstanceOf(BridgeSandboxClient);
    expect(sandbox.id).toBe('my-sandbox');
  });

  it('should throw when apiKey is missing', () => {
    expect(() =>
      getSandbox('my-sandbox', {
        baseUrl: 'https://bridge.example.com'
      })
    ).toThrow('API key required');
  });

  it('should throw when baseUrl is missing', () => {
    expect(() =>
      getSandbox('my-sandbox', {
        apiKey: 'test-key'
      })
    ).toThrow('Base URL required');
  });

  it('should throw when no options provided and env vars not set', () => {
    // In Workers runtime, process.env is not available
    // so this should throw
    expect(() => getSandbox('my-sandbox')).toThrow();
  });
});
