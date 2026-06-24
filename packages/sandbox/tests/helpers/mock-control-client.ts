import { vi } from 'vitest';
import type { Sandbox } from '../../src/sandbox';

/**
 * Default `startProcess` mock return value used by `sandbox.exec()`.
 *
 * Tests that only need "exec succeeded" get sensible defaults without having
 * to wire the new RPC path explicitly. Override per-test where the specific
 * pid / processId / command matters.
 */
function defaultStartProcessResponse(
  command: string,
  _sessionId: string
): Promise<{
  success: boolean;
  processId: string;
  pid: number;
  command: string;
  timestamp: string;
}> {
  return Promise.resolve({
    success: true,
    processId: `proc-${Math.random().toString(36).slice(2, 10)}`,
    pid: 1234,
    command,
    timestamp: new Date().toISOString()
  });
}

/**
 * Default `streamProcessLogs` mock that emits a single `exit` SSE frame and
 * closes. Lets the lazy `SandboxProcess.output()` / `exitCode` paths settle
 * immediately for tests that don't need a specific stream timing.
 */
function defaultStreamProcessLogs(
  processId: string
): Promise<ReadableStream<Uint8Array>> {
  return Promise.resolve(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const exitFrame = `data: ${JSON.stringify({ type: 'exit', exitCode: 0, processId, timestamp: new Date().toISOString() })}\n\n`;
        controller.enqueue(new TextEncoder().encode(exitFrame));
        controller.close();
      }
    })
  );
}

/**
 * Create a test double for Sandbox's container control client.
 *
 * Keep this aligned with ContainerControlClient's public surface so tests can
 * override only the methods relevant to the scenario under test.
 */
export function createMockControlClient(): Sandbox['client'] {
  return {
    commands: {
      // Default success used by internal infra paths (env setup,
      // bucket-mount helpers, backup, etc.) that still go through the
      // legacy `client.commands.execute` RPC. Override per-test when a
      // specific stdout/exitCode is required.
      execute: vi.fn().mockResolvedValue({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        command: '',
        timestamp: new Date().toISOString()
      }),
      executeStream: vi.fn()
    },
    files: {
      readFile: vi.fn(),
      readFileStream: vi.fn(),
      writeFile: vi.fn(),
      writeFileStream: vi.fn(),
      deleteFile: vi.fn(),
      renameFile: vi.fn(),
      moveFile: vi.fn(),
      mkdir: vi.fn(),
      listFiles: vi.fn(),
      exists: vi.fn()
    },
    processes: {
      // Pre-populated default so `sandbox.exec(cmd)` succeeds in tests that
      // don't override the mock. Override per-test when the test asserts on
      // a specific `processId` / `pid`.
      startProcess: vi.fn(defaultStartProcessResponse),
      listProcesses: vi.fn(),
      getProcess: vi.fn(),
      killProcess: vi.fn(),
      killAllProcesses: vi.fn(),
      getProcessLogs: vi.fn(),
      // Default emits an immediate exit so `.output()` / `exitCode` paths
      // settle without test-side wiring. Override when a test needs a
      // specific stdout/stderr/exit sequence.
      streamProcessLogs: vi.fn(defaultStreamProcessLogs)
    },
    ports: {
      watchPort: vi.fn()
    },
    utils: {
      ping: vi.fn(),
      getVersion: vi.fn(),
      getCommands: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      listSessions: vi.fn()
    },
    backup: {
      createArchive: vi.fn(),
      restoreArchive: vi.fn(),
      uploadParts: vi.fn()
    },
    watch: {
      watch: vi.fn(),
      checkChanges: vi.fn()
    },
    tunnels: {
      ensureTunnelRun: vi.fn(),
      stopTunnelRun: vi.fn()
    },
    terminals: {
      createTerminal: vi.fn(),
      destroyTerminal: vi.fn()
    },
    setRetryTimeoutMs: vi.fn(),
    isWebSocketConnected: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn()
  } as unknown as Sandbox['client'];
}
