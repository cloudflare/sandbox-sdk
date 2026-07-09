// Exercises OpenCode desired-state persistence across a real Durable Object
// eviction using the cloudflare:test evictDurableObject helper.

import * as cloudflareTest from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { OpenCodeFixture } from './eviction-fixture';

const { env, evictDurableObject } = cloudflareTest as typeof cloudflareTest & {
  evictDurableObject?: (stub: DurableObjectStub) => Promise<void>;
};

const fixtures = (
  env as unknown as {
    OpenCodeFixture: DurableObjectNamespace<OpenCodeFixture>;
  }
).OpenCodeFixture;

describe('OpenCode desired-state survives DO eviction', () => {
  it.skipIf(!evictDurableObject)(
    'recovers the persisted server config on a cold start',
    async () => {
      const id = fixtures.idFromName('evict-recover');

      // First incarnation: start a server with a runtime-only port override.
      const first = fixtures.get(id);
      await first.start({ port: 8080 });
      expect(await first.persistedState()).toMatchObject({
        port: 8080,
        directory: '/agents'
      });

      // Evict the DO from memory, simulating the production cold-start path.
      await evictDurableObject!(first);

      // Fresh incarnation: no in-memory state. A bare start() must recover the
      // persisted runtime override and respawn the same server.
      const revived = fixtures.get(id);
      await revived.coldStart();

      expect(await revived.startedCommands()).toContainEqual([
        'opencode',
        'serve',
        '--port',
        '8080',
        '--hostname',
        '0.0.0.0'
      ]);
    }
  );

  it.skipIf(!evictDurableObject)(
    'falls back to defaults on a cold start with no persisted override',
    async () => {
      const id = fixtures.idFromName('evict-empty');
      const handle = fixtures.get(id);
      // Bring the instance into memory without persisting any desired-state.
      expect(await handle.persistedState()).toBeUndefined();

      await evictDurableObject!(handle);

      // A bare start() on a cold DO with nothing persisted uses the factory
      // defaults (directory '/agents', default port).
      const revived = fixtures.get(id);
      await revived.coldStart();

      expect(await revived.startedCommands()).toContainEqual([
        'opencode',
        'serve',
        '--port',
        '4096',
        '--hostname',
        '0.0.0.0'
      ]);
    }
  );
});
