import { describe, expect, it, vi } from 'bun:test';
import { BunWebSocketShim } from '@sandbox-container/handlers/bun-ws-shim';

function createMockServerWebSocket() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    data: { type: 'capnweb', connectionId: 'test-conn' }
  };
}

describe('BunWebSocketShim', () => {
  describe('readyState', () => {
    it('should report OPEN (1)', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);
      expect(shim.readyState).toBe(1);
    });
  });

  describe('send', () => {
    it('should delegate to ServerWebSocket.send', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);
      shim.send('hello');
      expect(ws.send).toHaveBeenCalledWith('hello');
    });

    it('should handle binary data', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);
      const data = new Uint8Array([1, 2, 3]);
      shim.send(data);
      expect(ws.send).toHaveBeenCalledWith(data);
    });
  });

  describe('close', () => {
    it('should delegate to ServerWebSocket.close', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);
      shim.close(1000, 'normal');
      expect(ws.close).toHaveBeenCalledWith(1000, 'normal');
    });

    it('should handle close without arguments', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);
      shim.close();
      expect(ws.close).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('addEventListener / dispatchMessage', () => {
    it('should deliver message events to registered listeners', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);

      const handler = vi.fn();
      shim.addEventListener('message', handler);

      shim.dispatchMessage('{"type":"test"}');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({
        data: '{"type":"test"}'
      });
    });

    it('should convert Buffer to string', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);

      const handler = vi.fn();
      shim.addEventListener('message', handler);

      shim.dispatchMessage(Buffer.from('hello'));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({ data: 'hello' });
    });

    it('should support multiple listeners for the same event', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      shim.addEventListener('message', handler1);
      shim.addEventListener('message', handler2);

      shim.dispatchMessage('test');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('addEventListener / dispatchClose', () => {
    it('should deliver close events', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);

      const handler = vi.fn();
      shim.addEventListener('close', handler);

      shim.dispatchClose(1000, 'normal');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({
        code: 1000,
        reason: 'normal'
      });
    });
  });

  describe('addEventListener / dispatchError', () => {
    it('should deliver error events', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);

      const handler = vi.fn();
      shim.addEventListener('error', handler);

      const err = new Error('connection lost');
      shim.dispatchError(err);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({ error: err });
    });
  });

  describe('removeEventListener', () => {
    it('should remove a registered listener', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);

      const handler = vi.fn();
      shim.addEventListener('message', handler);
      shim.removeEventListener('message', handler);

      shim.dispatchMessage('test');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should not throw when removing a listener that was never added', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);
      expect(() => shim.removeEventListener('message', vi.fn())).not.toThrow();
    });
  });

  describe('no listeners registered', () => {
    it('should not throw when dispatching with no listeners', () => {
      const ws = createMockServerWebSocket();
      const shim = new BunWebSocketShim(ws as any);

      expect(() => shim.dispatchMessage('test')).not.toThrow();
      expect(() => shim.dispatchClose(1000, '')).not.toThrow();
      expect(() => shim.dispatchError(new Error('test'))).not.toThrow();
    });
  });
});
