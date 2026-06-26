// Test fixture worker for OpenCode DO-eviction tests.
//
// Re-exports the SDK worker surface and adds a Durable Object with an OpenCode
// lifecycle handle wired to real `ctx.storage`. The eviction test drives this
// DO through its namespace binding so persisted desired-state can be checked
// across a genuine eviction.
//
// The container is not available in the Workers test runtime, so the fixture
// stubs the container-touching sandbox methods (`exec`/`getProcess`) while
// leaving `ctx.storage` real — exactly the surface the persistence layer
// exercises.

import { DurableObject } from 'cloudflare:workers';
import {
  type OpenCodeHandle,
  withOpenCode
} from '../../src/opencode/lifecycle';
import type { Sandbox } from '../../src/sandbox';

interface StartedProcess {
  command: string;
  options: { processId?: string };
}

/**
 * Durable Object exposing an OpenCode handle backed by real DO storage. The
 * captured "sandbox" is a stub: process operations are recorded in memory, so
 * the test can assert what a cold-start re-ensure would spawn without a
 * container.
 */
export class OpenCodeFixture extends DurableObject {
  #handle: OpenCodeHandle;
  #started: StartedProcess[] = [];

  constructor(ctx: DurableObjectState, env: never) {
    super(ctx, env);

    const sandbox = {
      exec: async (command: string, options: { processId?: string } = {}) => {
        this.#started.push({ command, options });
        return {
          id: options.processId ?? 'proc',
          command,
          startTime: new Date(),
          exitCode: Promise.resolve(0),
          waitForPort: async () => {},
          kill: () => {},
          getLogs: async () => ({ stdout: '', stderr: '' }),
          status: async () => 'running'
        };
      },
      getProcess: async () => null,
      listProcesses: async () => [],
      containerFetch: async () => new Response('ok'),
      // SandboxExtension captures `client`; never touched in these tests.
      client: {}
    } as unknown as Sandbox;

    this.#handle = withOpenCode(sandbox, {
      directory: '/agents',
      storage: ctx.storage
    });
  }

  /** Start (and persist) the server with the given options. */
  async start(options?: { port?: number; directory?: string }): Promise<void> {
    await this.#handle.start(options);
  }

  /** A bare start() after a cold start recovers persisted desired-state. */
  async coldStart(): Promise<void> {
    await this.#handle.start();
  }

  /** Commands the stub sandbox was asked to start, in order. */
  startedCommands(): string[] {
    return this.#started.map((entry) => entry.command);
  }

  /** Raw persisted desired-state, read straight from DO storage. */
  async persistedState(): Promise<unknown> {
    return this.ctx.storage.get('opencode:desired-state:0');
  }
}
