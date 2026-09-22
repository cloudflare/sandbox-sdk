import { describe, expect, it } from 'vitest';
import { createHandler } from '../src/index.js';
import type { SessionManager } from '../src/types.js';

function fixture() {
  const calls: Array<{ method: string; args: string[] }> = [];
  const manager: SessionManager = {
    async create(input) {
      calls.push({ method: 'create', args: [input] });
      return { sessionID: 'sess_1', output: 'created output' };
    },
    async run(sessionID, input) {
      calls.push({ method: 'run', args: [sessionID, input] });
      return { sessionID, output: 'follow-up output' };
    },
    async delete(sessionID) {
      calls.push({ method: 'delete', args: [sessionID] });
    }
  };
  return { app: createHandler(manager), calls };
}

describe('basic Agents API HTTP application', () => {
  it('reports health', async () => {
    const { app } = fixture();

    const response = await app(new Request('http://example.test/health'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('creates a session and runs its first input', async () => {
    const { app, calls } = fixture();

    const response = await app(
      new Request('http://example.test/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Create a file' })
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      session_id: 'sess_1',
      output: 'created output'
    });
    expect(calls).toEqual([{ method: 'create', args: ['Create a file'] }]);
  });

  it('runs follow-up input in an existing session', async () => {
    const { app, calls } = fixture();

    const response = await app(
      new Request('http://example.test/sessions/sess_1/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Read the file' })
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session_id: 'sess_1',
      output: 'follow-up output'
    });
    expect(calls).toEqual([
      { method: 'run', args: ['sess_1', 'Read the file'] }
    ]);
  });

  it('runs a complete demo and cleans up its session', async () => {
    const { app, calls } = fixture();

    const response = await app(
      new Request('http://example.test/demo', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session_id: 'sess_1',
      initial_output: 'created output',
      follow_up_output: 'follow-up output',
      cleaned_up: true
    });
    expect(calls[0]?.method).toBe('create');
    expect(calls[0]?.args[0]).toMatch(/write.*basic-demo\.txt/i);
    expect(calls[1]).toEqual({
      method: 'run',
      args: [
        'sess_1',
        'Read /workspace/basic-demo.txt and reply with its exact contents.'
      ]
    });
    expect(calls[2]).toEqual({ method: 'delete', args: ['sess_1'] });
  });

  it('cleans up a demo when its follow-up fails', async () => {
    const calls: string[] = [];
    const manager: SessionManager = {
      async create() {
        calls.push('create');
        return { sessionID: 'sess_1', output: 'created output' };
      },
      async run() {
        calls.push('run');
        throw new Error('follow-up failed');
      },
      async delete() {
        calls.push('delete');
      }
    };
    const app = createHandler(manager);

    const response = await app(
      new Request('http://example.test/demo', { method: 'POST' })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'follow-up failed'
    });
    expect(calls).toEqual(['create', 'run', 'delete']);
  });

  it('deletes a session and its executor', async () => {
    const { app, calls } = fixture();

    const response = await app(
      new Request('http://example.test/sessions/sess_1', {
        method: 'DELETE'
      })
    );

    expect(response.status).toBe(204);
    expect(calls).toEqual([{ method: 'delete', args: ['sess_1'] }]);
  });

  it('rejects missing input', async () => {
    const { app, calls } = fixture();

    const response = await app(
      new Request('http://example.test/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '  ' })
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'input must be a non-empty string'
    });
    expect(calls).toEqual([]);
  });

  it('returns JSON for application errors', async () => {
    const manager: SessionManager = {
      async create() {
        throw new Error('session failed');
      },
      async run() {
        throw new Error('session failed');
      },
      async delete() {
        throw new Error('session failed');
      }
    };
    const app = createHandler(manager);

    const response = await app(
      new Request('http://example.test/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Run' })
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'session failed' });
  });
});
