import { describe, expect, it, vi } from 'vitest';
import {
  createAtomicWriteTempPath,
  getAtomicWriteTargetPath
} from '../src/atomic-write-path';

describe('atomic write paths', () => {
  it('round-trips the target path through the temporary path', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '123e4567-e89b-42d3-a456-426614174000'
    );

    const tempPath = createAtomicWriteTempPath('/mnt/data/file.bin');

    expect(tempPath).toBe(
      '/mnt/data/file.bin.tmp.123e4567-e89b-42d3-a456-426614174000'
    );
    expect(getAtomicWriteTargetPath(tempPath)).toBe('/mnt/data/file.bin');
    expect(getAtomicWriteTargetPath('/mnt/data/file.bin.tmp.not-a-uuid')).toBe(
      null
    );
  });
});
