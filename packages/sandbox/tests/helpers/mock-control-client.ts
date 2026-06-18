import { vi } from 'vitest';
import type { Sandbox } from '../../src/sandbox';

/**
 * Create a test double for Sandbox's container control client.
 *
 * Keep this aligned with ContainerControlClient's public surface so tests can
 * override only the methods relevant to the scenario under test.
 */
export function createMockControlClient(): Sandbox['client'] {
  return {
    commands: {
      execute: vi.fn(),
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
      startProcess: vi.fn(),
      listProcesses: vi.fn(),
      getProcess: vi.fn(),
      killProcess: vi.fn(),
      killAllProcesses: vi.fn(),
      getProcessLogs: vi.fn(),
      streamProcessLogs: vi.fn()
    },
    ports: {
      watchPort: vi.fn()
    },
    git: {
      checkout: vi.fn()
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
      runQuickTunnel: vi.fn(),
      runNamedTunnel: vi.fn(),
      destroyTunnel: vi.fn(),
      listTunnels: vi.fn()
    },
    setRetryTimeoutMs: vi.fn(),
    isWebSocketConnected: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn()
  } as unknown as Sandbox['client'];
}
