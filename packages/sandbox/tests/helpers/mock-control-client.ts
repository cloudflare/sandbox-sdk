import { vi } from 'vitest';
import type { ContainerControlClient } from '../../src/container-control';
import type { Sandbox } from '../../src/sandbox';

export type SandboxWithClient<Env = unknown> = Sandbox<Env> & {
  client: ContainerControlClient;
};

export function asSandboxWithClient<Env = unknown>(
  sandbox: Sandbox<Env>
): SandboxWithClient<Env> {
  return sandbox as SandboxWithClient<Env>;
}

/**
 * Create a test double for Sandbox's container control client.
 *
 * Keep this aligned with ContainerControlClient's public surface so tests can
 * override only the methods relevant to the scenario under test.
 */
export function createMockControlClient(): ContainerControlClient {
  return {
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
    ports: {
      openWatch: vi.fn(async () => ({
        stream: vi.fn(
          async () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'ready' });
                controller.close();
              }
            })
        ),
        cancel: vi.fn(async () => undefined),
        [Symbol.dispose]: vi.fn()
      }))
    },
    processes: {
      start: vi.fn(async (command) => ({
        id: 'mock-process-id',
        pid: 123,
        command,
        state: 'running',
        startedAt: new Date().toISOString()
      })),
      get: vi.fn(async (id) => ({
        id,
        pid: 123,
        command: ['/bin/true'],
        state: 'running',
        startedAt: new Date().toISOString()
      })),
      list: vi.fn(async () => []),
      openLogs: vi.fn(async () => ({
        stream: vi.fn(
          async () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({
                  state: 'exited',
                  cursor: '1',
                  timestamp: new Date().toISOString(),
                  exit: { code: 0, timedOut: false }
                });
                controller.close();
              }
            })
        ),
        cancel: vi.fn(async () => undefined),
        [Symbol.dispose]: vi.fn()
      })),
      kill: vi.fn(),
      hasActive: vi.fn(async () => false)
    },
    mounts: {
      pathExists: vi.fn(async () => true),
      ensureDirectory: vi.fn(async () => undefined),
      chmodOwnerOnly: vi.fn(async () => undefined),
      deleteFile: vi.fn(async () => undefined),
      mountS3FS: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: ''
      })),
      mountS3FSAndVerify: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: ''
      })),
      isMountpoint: vi.fn(async () => true),
      unmountFuse: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: ''
      })),
      unmountFuseIfMounted: vi.fn(async () => undefined),
      removeMountDirectory: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: ''
      }))
    },
    utils: {
      ping: vi.fn()
    },
    workspace: {
      createArchive: vi.fn(async () => ({ archivePath: '/tmp/archive.tar' })),
      extractArchive: vi.fn(async () => undefined),
      cleanupArchive: vi.fn(async () => undefined)
    },
    backup: {
      createArchive: vi.fn(),
      restoreArchive: vi.fn(async () => ({ success: true })),
      uploadArchive: vi.fn(async () => undefined),
      uploadParts: vi.fn(async () => ({ success: true, parts: [] })),
      prepareRestore: vi.fn(async () => ({ existingSize: 0 })),
      downloadArchive: vi.fn(async () => undefined),
      extractArchive: vi.fn(async () => undefined),
      cleanupArchive: vi.fn(async () => undefined)
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
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      output: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      interrupt: vi.fn(),
      terminate: vi.fn(),
      hasActive: vi.fn()
    },
    isWebSocketConnected: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn()
  } as unknown as ContainerControlClient;
}
