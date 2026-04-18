/**
 * Codex App Server JSON-RPC types and message handler pipeline.
 *
 * The wire protocol is JSON-RPC 2.0 with the "jsonrpc" field omitted.
 */

// --- Types ---

export interface JsonRpcRequest {
  method: string;
  id: number | string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

export function tryParse(data: string): JsonRpcMessage | null {
  try {
    return JSON.parse(data) as JsonRpcMessage;
  } catch {
    return null;
  }
}

// --- Handler pipeline ---
//
// Each handler inspects a message flowing through the WebSocket bridge and:
//   - Returns it (possibly rewritten) to forward downstream
//   - Returns null to drop it (after optionally responding via ctx)

export interface HandlerContext {
  direction: 'client-to-server' | 'server-to-client';
  sendToClient: (msg: JsonRpcMessage) => void;
  sendToServer: (msg: JsonRpcMessage) => void;
}

export type MessageHandler = (
  msg: JsonRpcMessage,
  ctx: HandlerContext
) => JsonRpcMessage | null;

export function compose(...handlers: MessageHandler[]): MessageHandler {
  return (msg, ctx) => {
    let current: JsonRpcMessage | null = msg;
    for (const h of handlers) {
      if (!current) return null;
      current = h(current, ctx);
    }
    return current;
  };
}

// --- Built-in handlers ---

export function log(): MessageHandler {
  return (msg, ctx) => {
    const arrow = ctx.direction === 'client-to-server' ? '>>>' : '<<<';
    if (isRequest(msg)) {
      console.log(`[bridge] ${arrow} ${msg.method} (id=${msg.id})`);
    } else if ('method' in msg) {
      console.log(`[bridge] ${arrow} ${(msg as JsonRpcNotification).method}`);
    } else {
      const r = msg as JsonRpcResponse;
      console.log(
        `[bridge] ${arrow} response id=${r.id} ${r.error ? 'ERROR' : 'OK'}`
      );
    }
    return msg;
  };
}

/** Force a specific model on thread/start and turn/start requests. */
export function enforceModel(model: string): MessageHandler {
  return (msg, ctx) => {
    if (
      ctx.direction === 'client-to-server' &&
      isRequest(msg) &&
      (msg.method === 'thread/start' || msg.method === 'turn/start') &&
      msg.params
    ) {
      return { ...msg, params: { ...msg.params, model } };
    }
    return msg;
  };
}

/** Override approval and sandbox policies on turn/start, thread/start, and command/exec. */
export function enforcePolicy(overrides: {
  approvalPolicy?: string;
  sandboxPolicy?: Record<string, unknown>;
}): MessageHandler {
  return (msg, ctx) => {
    if (ctx.direction !== 'client-to-server' || !isRequest(msg) || !msg.params)
      return msg;

    if (msg.method === 'turn/start' || msg.method === 'thread/start') {
      return { ...msg, params: { ...msg.params, ...overrides } };
    }

    // command/exec: enforce sandboxPolicy only (no approvalPolicy on direct exec)
    if (msg.method === 'command/exec' && overrides.sandboxPolicy) {
      return {
        ...msg,
        params: { ...msg.params, sandboxPolicy: overrides.sandboxPolicy }
      };
    }

    return msg;
  };
}

/** Auto-approve tool execution requests; drop them before reaching the client. */
export function autoApprove(): MessageHandler {
  let syntheticId = 100_000;
  return (msg, ctx) => {
    if (ctx.direction !== 'server-to-client' || !isRequest(msg)) return msg;
    if (
      msg.method !== 'item/commandExecution/requestApproval' &&
      msg.method !== 'item/fileChange/requestApproval'
    ) {
      return msg;
    }

    const p = (msg.params ?? {}) as Record<string, unknown>;
    ctx.sendToServer({
      method: msg.method.replace('/requestApproval', '/approve'),
      id: syntheticId++,
      params: {
        itemId: p.itemId,
        threadId: p.threadId,
        turnId: p.turnId,
        decision: 'accept'
      }
    });
    return null;
  };
}
