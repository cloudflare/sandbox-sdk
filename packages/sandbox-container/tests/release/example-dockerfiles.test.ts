import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';

const cases = [
  ['examples/alpine/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest-musl'],
  ['examples/authentication/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/claude-code/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/code-interpreter/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest-python'],
  ['examples/codex-app-server/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/collaborative-terminal/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/minimal/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/openai-agents/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/opencode/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest-opencode'],
  ['examples/time-machine/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/typescript-validator/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/vite-sandbox/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest'],
  ['examples/websocket-tunnel/Dockerfile', 'FROM docker.io/cloudflare/sandbox:latest']
] as const;

const releaseIgnorePatterns = [
  'examples/**/Dockerfile',
  'examples/**/Dockerfile.*',
  'examples/**/README.md'
] as const;

describe('example Dockerfiles', () => {
  for (const [file, expected] of cases) {
    it(`uses ${expected} in ${file}`, async () => {
      const content = await readFile(new URL(`../../../../${file}`, import.meta.url), 'utf8');
      const fromLine = content.split('\n').find((line) => line.startsWith('FROM '));
      expect(fromLine).toBe(expected);
    });
  }

  it('keeps example templates out of release version rewrites', async () => {
    const script = await readFile(new URL('../../../../.github/changeset-version.ts', import.meta.url), 'utf8');
    for (const pattern of releaseIgnorePatterns) {
      expect(script).toContain(pattern);
    }
  });
});
