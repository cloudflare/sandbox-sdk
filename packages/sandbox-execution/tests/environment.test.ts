import { describe, expect, it } from 'bun:test';

describe('container-backed tests', () => {
  it('runs in Linux instead of the host operating system', () => {
    expect(process.platform).toBe('linux');
  });
});
