/**
 * Adapts Bun's ServerWebSocket to the standard WebSocket interface
 * expected by capnweb's newWebSocketRpcSession().
 *
 * Bun's ServerWebSocket uses callback-based handlers registered on
 * the serve() config, not addEventListener. capnweb registers event
 * listeners for "message", "close", and "error" via addEventListener.
 *
 * This shim captures those listeners and exposes dispatch methods
 * that the Bun server callbacks invoke.
 */
import type { ServerWebSocket } from 'bun';

type EventHandler = (event: unknown) => void;

export class BunWebSocketShim {
  #ws: ServerWebSocket<unknown>;
  #listeners: Map<string, EventHandler[]> = new Map();

  constructor(ws: ServerWebSocket<unknown>) {
    this.#ws = ws;
  }

  /**
   * capnweb checks readyState to determine if the WebSocket is already open.
   * Bun's ServerWebSocket is always open by the time the `open` callback fires.
   */
  get readyState(): number {
    return 1; // WebSocket.OPEN
  }

  addEventListener(type: string, handler: EventHandler): void {
    let handlers = this.#listeners.get(type);
    if (!handlers) {
      handlers = [];
      this.#listeners.set(type, handlers);
    }
    handlers.push(handler);
  }

  removeEventListener(type: string, handler: EventHandler): void {
    const handlers = this.#listeners.get(type);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.#ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#ws.close(code, reason);
  }

  // --- Dispatch methods called from Bun server callbacks ---

  dispatchMessage(data: string | Buffer): void {
    const handlers = this.#listeners.get('message');
    if (!handlers) return;
    const strData = typeof data === 'string' ? data : data.toString('utf-8');
    const event = { data: strData };
    for (const handler of handlers) {
      handler(event);
    }
  }

  dispatchClose(code: number, reason: string): void {
    const handlers = this.#listeners.get('close');
    if (!handlers) return;
    const event = { code, reason };
    for (const handler of handlers) {
      handler(event);
    }
  }

  dispatchError(error: Error): void {
    const handlers = this.#listeners.get('error');
    if (!handlers) return;
    const event = { error };
    for (const handler of handlers) {
      handler(event);
    }
  }
}
