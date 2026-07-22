/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import type { ProcessLogEvent } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { RPCTransportError } from '../../src';
import { createSandboxProcess } from '../../src/processes';
import { readProcessOutput } from '../../src/processes/process-output';
import type { ProcessPullSubscriptionRPC } from '../../src/processes/rpc-types';
import type { ProcessCapabilityRPCTestDO } from '../fixtures/process-capability-rpc';

declare global {
  namespace Cloudflare {
    interface Env {
      ProcessCapabilityTest: DurableObjectNamespace<ProcessCapabilityRPCTestDO>;
    }
  }
}

describe('process capability Workers RPC', () => {
  it('roundtrips descriptor values and invokes the private capability', async () => {
    const id = env.ProcessCapabilityTest.idFromName('roundtrip');
    const descriptor = await env.ProcessCapabilityTest.get(id).descriptor();

    expect(descriptor.id).toBe('p1');
    expect(descriptor.pid).toBe(123);
    await expect(descriptor.capability.status()).resolves.toMatchObject({
      id: 'p1',
      pid: 123,
      state: 'running'
    });
  });

  it('allows replay-only logs to close cleanly through the capability', async () => {
    const id = env.ProcessCapabilityTest.idFromName('replay-close');
    const descriptor = await env.ProcessCapabilityTest.get(id).descriptor();
    // Workers RPC's Stub transform cannot represent a disposable stream
    // capability, so refine the real boundary result to its wire contract.
    const subscription =
      (await descriptor.capability.openLogs()) as unknown as ProcessPullSubscriptionRPC<never>;

    await expect(subscription.next()).resolves.toEqual({
      done: true,
      value: undefined
    });
    subscription[Symbol.dispose]();
  });

  it('rejects premature replay-follow completion through the capability', async () => {
    const id = env.ProcessCapabilityTest.idFromName('follow-close');
    const descriptor = await env.ProcessCapabilityTest.get(id).descriptor();
    // Workers RPC's Stub transform cannot represent a disposable stream
    // capability, so refine the real boundary result to its wire contract.
    const subscription = (await descriptor.capability.openLogs({
      replay: true,
      follow: true
    })) as unknown as ProcessPullSubscriptionRPC<ProcessLogEvent>;
    const reader = {
      read: () => subscription.next()
    } as ReadableStreamDefaultReader<ProcessLogEvent>;

    await expect(
      readProcessOutput(reader, {
        processId: descriptor.id,
        pid: descriptor.pid
      })
    ).rejects.toBeInstanceOf(RPCTransportError);
    subscription[Symbol.dispose]();
  });

  it('rejects a caller-local facade at a second Workers RPC boundary', async () => {
    const id = env.ProcessCapabilityTest.idFromName('second-boundary');
    const stub = env.ProcessCapabilityTest.get(id);
    const process = createSandboxProcess({
      id: 'p1',
      pid: 123,
      capability: {
        status: vi.fn(),
        openLogs: vi.fn(),
        openPortWatch: vi.fn(),
        kill: vi.fn()
      }
    });

    const rejected = stub.accept(process).then(
      () => false,
      (error: Error) => {
        expect(error.message).toContain('does not support serialization');
        return true;
      }
    );
    await expect(rejected).resolves.toBe(true);
    await expect(stub.descriptor()).resolves.toMatchObject({ id: process.id });
  });
});
