import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new NodeURL('..', import.meta.url));

describe('Container entrypoint', () => {
  it('rejects missing executor settings', () => {
    const result = spawnSync('./bin/start-executor', {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PATH: process.env.PATH }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('CODEX_API_KEY is required');
  });

  it('rejects a missing remote URL', () => {
    const result = spawnSync('./bin/start-executor', {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: process.env.PATH,
        CODEX_API_KEY: 'executor-key',
        OPENAI_ENVIRONMENT_ID: 'env_1'
      }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('OPENAI_REMOTE_URL is required');
  });

  it('starts the Codex executor with the configured environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-api-executor-'));
    const codex = join(directory, 'codex');
    await writeFile(codex, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(codex, 0o755);

    const result = spawnSync('./bin/start-executor', {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CODEX_API_KEY: 'executor-key',
        OPENAI_ENVIRONMENT_ID: 'env_1',
        OPENAI_REMOTE_URL: 'https://agents.example.test/v1'
      }
    });
    await rm(directory, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(
      'exec-server\n--remote\nhttps://agents.example.test/v1\n--environment-id\nenv_1\n'
    );
  });
});
