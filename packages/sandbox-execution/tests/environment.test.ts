import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

describe('container-backed tests', () => {
  it('runs in Linux instead of the host operating system', () => {
    expect(process.platform).toBe('linux');
  });

  it('enforces source boundary for sandbox-execution', () => {
    const srcDir = join(__dirname, '../src');
    const walk = (dir: string): string[] => {
      let results: string[] = [];
      const list = readdirSync(dir);
      for (const file of list) {
        const path = join(dir, file);
        const stat = statSync(path);
        if (stat?.isDirectory()) {
          results = results.concat(walk(path));
        } else if (file.endsWith('.ts')) {
          results.push(path);
        }
      }
      return results;
    };

    const sourceFiles = walk(srcDir);
    const forbiddenPatterns = [/@repo\/shared/, /capnweb/, /cloudflare:/];

    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          throw new Error(
            `Forbidden pattern ${pattern} found in ${file}. sandbox-execution must remain independent.`
          );
        }
      }
    }
  });
});
