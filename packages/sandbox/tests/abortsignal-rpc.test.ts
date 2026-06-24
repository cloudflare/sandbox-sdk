/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSandbox, type Sandbox } from '../src/sandbox';

/**
 * The two regression projects inject the Sandbox DO namespace and the
 * `ABORTSIGNAL_RPC_ENABLED` flag binding. `cloudflare:test` types `env` as the
 * shared (empty) `Cloudflare.Env`, so we narrow it locally rather than
 * augmenting the global `Env` used throughout the SDK source.
 */
const testEnv = env as unknown as {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ABORTSIGNAL_RPC_ENABLED: boolean;
};

/**
 * Regression tests for https://github.com/cloudflare/sandbox-sdk/issues/764
 *
 * `ExecOptions` accepts `signal?: AbortSignal`, but the options object is
 * structured-cloned across the Worker -> Durable Object RPC boundary. An
 * `AbortSignal` is not cloneable unless the `enable_abortsignal_rpc`
 * compatibility flag is set, so passing one straight to the DO stub throws
 *
 *   DataCloneError: AbortSignal serialization is not enabled.
 *
 * before the command ever runs.
 *
 * Compatibility flags are fixed per workerd isolate at startup, so a single
 * test run cannot toggle the flag. Instead this file runs under two Vitest
 * projects (see vitest.config.ts):
 *
 *   - `sandbox-abortsignal-rpc-disabled`: boots the pool WITHOUT the flag
 *     (ABORTSIGNAL_RPC_ENABLED = false).
 *   - `sandbox-abortsignal-rpc-enabled`: boots the pool WITH the flag
 *     (ABORTSIGNAL_RPC_ENABLED = true).
 *
 * The `ABORTSIGNAL_RPC_ENABLED` binding tells each test which mode it runs
 * under, so the same assertions capture both directions.
 *
 * The serialization happens while marshalling the call arguments — i.e.
 * before the container is contacted — so the results are meaningful even
 * though no container runs in the unit-test environment. A later, unrelated
 * "Containers have not been enabled" error is expected once a call gets past
 * the boundary and proves the AbortSignal serialized fine.
 */
function isAbortSignalCloneError(thrown: unknown): boolean {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return (
    (thrown instanceof Error && thrown.name === 'DataCloneError') ||
    /AbortSignal serialization is not enabled/i.test(message)
  );
}

const flagEnabled = testEnv.ABORTSIGNAL_RPC_ENABLED;

describe('AbortSignal across the raw DO stub (issue #764)', () => {
  it('matches enable_abortsignal_rpc when a signal is passed to the stub', async () => {
    const id = testEnv.Sandbox.idFromName('abortsignal-rpc-raw');
    const stub = testEnv.Sandbox.get(id);

    const controller = new AbortController();

    let thrown: unknown;
    try {
      await stub.exec('echo hi', { signal: controller.signal });
    } catch (error) {
      thrown = error;
    }

    const cloneError = isAbortSignalCloneError(thrown);
    const message = thrown instanceof Error ? thrown.message : String(thrown);

    if (flagEnabled) {
      expect(
        cloneError,
        `With enable_abortsignal_rpc set, a raw stub call must not throw a ` +
          `structured-clone error. Got: ${message}`
      ).toBe(false);
    } else {
      // The raw, unguarded boundary still throws — this is the bug the SDK
      // proxy guards against below.
      expect(
        cloneError,
        `Without enable_abortsignal_rpc, a raw stub call is expected to throw ` +
          `the structured-clone error. Got: ${message}`
      ).toBe(true);
    }
  });
});

describe('getSandbox().exec() with an AbortSignal (issue #764 fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw a structured-clone error and warns when the flag is off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sandbox = getSandbox(testEnv.Sandbox, 'abortsignal-rpc-sdk');
    const controller = new AbortController();

    let thrown: unknown;
    try {
      await sandbox.exec('echo hi', { signal: controller.signal });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);

    // Regardless of the flag, the SDK must never surface the AbortSignal
    // structured-clone error to the caller.
    expect(
      isAbortSignalCloneError(thrown),
      `getSandbox().exec() must not surface the AbortSignal clone error. ` +
        `Got: ${message}`
    ).toBe(false);

    // The logger emits structured records (objects), so match against the
    // serialized call arguments rather than assuming a string first arg.
    const warnedAboutFlag = warn.mock.calls.some((call) =>
      /enable_abortsignal_rpc/i.test(
        call.map((arg) => JSON.stringify(arg)).join(' ')
      )
    );

    if (flagEnabled) {
      // Flag on: the signal serializes, so no warning is emitted.
      expect(warnedAboutFlag).toBe(false);
    } else {
      // Flag off: the signal is stripped and the user is told to set the flag.
      expect(
        warnedAboutFlag,
        'Expected a warning mentioning enable_abortsignal_rpc when the flag ' +
          'is off and a signal is passed.'
      ).toBe(true);
    }
  });
});
