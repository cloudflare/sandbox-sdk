import {
  type CreateWorkspaceArchiveRequest,
  type CreateWorkspaceArchiveResult,
  type ExtractWorkspaceArchiveRequest,
  shellEscape
} from '@repo/shared';
import type { CommandContextService } from './command-context-service';

const SAFE_ROOT = '/workspace';
const TMP_PREFIX = '/tmp/sandbox-workspace-';

function assertSafeRoot(path: string): void {
  if (path !== SAFE_ROOT) {
    throw new Error('workspace root must be /workspace');
  }
}

function assertSafeArchivePath(path: string): void {
  if (!path.startsWith(TMP_PREFIX) || !path.endsWith('.tar')) {
    throw new Error('archive path must be a sandbox workspace temp tar path');
  }
  if (path.includes('\0') || path.includes('..')) {
    throw new Error('archive path must not contain NUL or traversal segments');
  }
}

function normalizeExclude(path: string): string {
  if (path.length === 0 || path.includes('\0')) {
    throw new Error(
      'exclude paths must be non-empty strings without NUL bytes'
    );
  }
  const relative = path.replace(/^\.\//, '');
  if (
    relative.startsWith('/') ||
    relative === '.' ||
    relative === '..' ||
    relative.includes('/../') ||
    relative.startsWith('../') ||
    relative.endsWith('/..')
  ) {
    throw new Error('exclude paths must be relative and must not traverse');
  }
  return `./${relative}`;
}

export class WorkspaceArchiveService {
  readonly #commands: CommandContextService;

  constructor(commands: CommandContextService) {
    this.#commands = commands;
  }

  async createArchive(
    request: CreateWorkspaceArchiveRequest
  ): Promise<CreateWorkspaceArchiveResult> {
    assertSafeRoot(request.root);
    const excludes = request.excludes.map(normalizeExclude);
    const archivePath = `${TMP_PREFIX}${crypto.randomUUID()}.tar`;
    const excludeArgs = excludes
      .map((exclude) => `--exclude ${shellEscape(exclude)}`)
      .join(' ');
    const command = excludeArgs
      ? `tar cf ${shellEscape(archivePath)} ${excludeArgs} -C ${shellEscape(request.root)} .`
      : `tar cf ${shellEscape(archivePath)} -C ${shellEscape(request.root)} .`;
    const result = await this.#commands.run(command);
    if (result.exitCode !== 0) {
      await this.cleanupArchive(archivePath).catch(() => {});
      throw new Error(`tar failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return { archivePath };
  }

  async extractArchive(request: ExtractWorkspaceArchiveRequest): Promise<void> {
    assertSafeRoot(request.root);
    assertSafeArchivePath(request.archivePath);
    const command = [
      `mkdir -p ${shellEscape(request.root)}`,
      `tar xf ${shellEscape(request.archivePath)} -C ${shellEscape(request.root)}`,
      `rm -f ${shellEscape(request.archivePath)}`
    ].join(' && ');
    const result = await this.#commands.run(command);
    if (result.exitCode !== 0) {
      await this.cleanupArchive(request.archivePath).catch(() => {});
      throw new Error(
        `tar extract failed (exit ${result.exitCode}): ${result.stderr}`
      );
    }
  }

  async cleanupArchive(archivePath: string): Promise<void> {
    assertSafeArchivePath(archivePath);
    await this.#commands.run(`rm -f ${shellEscape(archivePath)}`);
  }
}
