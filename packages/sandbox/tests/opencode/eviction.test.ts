// packages/sandbox/tests/opencode/eviction.test.ts
//
// Exercises OpenCode desired-state persistence across a real Durable Object
// eviction using the cloudflare:test evictDurableObject helper.

import { env, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { OpenCodeFixture } from './eviction-fixture';

const fixtures = (
  env as unknown as {
    OpenCodeFixture: DurableObjectNamespace<OpenCodeFixture>;
  }
).OpenCodeFixture;

describe('OpenCode desired-state survives DO eviction', () => {
  it('recovers the persisted server config on a cold start', async () => {
    const id = fixtures.idFromName('evict-recover');

    // First incarnation: start a server with a runtime-only port override.
    const first = fixtures.get(id);
    await first.start({ port: 8080 });
    expect(await first.persistedState()).toMatchObject({
      port: 8080,
      directory: '/agents'
    });

    // Evict the DO from memory, simulating the production cold-start path.
    await evictDurableObject(first);

    // Fresh incarnation: no in-memory #lastOptions. Re-ensure must recover the
    // persisted desired-state and respawn the same server.
    const revived = fixtures.get(id);
    await revived.reEnsure();

    expect(await revived.startedCommands()).toContain(
      'cd /agents && opencode serve --port 8080 --hostname 0.0.0.0'
    );
  });

  it('does not respawn when nothing was ever persisted', async () => {
    const id = fixtures.idFromName('evict-empty');
    const handle = fixtures.get(id);
    // Bring the instance into memory without persisting any desired-state.
    expect(await handle.persistedState()).toBeUndefined();

    await evictDurableObject(handle);

    const revived = fixtures.get(id);
    await revived.reEnsure();

    expect(await revived.startedCommands()).toEqual([]);
  });
});
