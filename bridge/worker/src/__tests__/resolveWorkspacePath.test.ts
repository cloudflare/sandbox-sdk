import { describe, expect, it } from 'vitest';
import { resolveWorkspacePath } from '../../../../packages/sandbox/src/bridge/helpers';

describe('resolveWorkspacePath', () => {
  // --- Valid paths that should resolve successfully ---

  it('accepts an absolute path within /workspace', () => {
    expect(resolveWorkspacePath('/workspace/foo.txt')).toBe('/workspace/foo.txt');
  });

  it('resolves a relative path against /workspace', () => {
    expect(resolveWorkspacePath('foo.txt')).toBe('/workspace/foo.txt');
  });

  it('resolves ".." segments that stay inside /workspace', () => {
    expect(resolveWorkspacePath('/workspace/a/../b')).toBe('/workspace/b');
  });

  it('accepts exactly /workspace', () => {
    expect(resolveWorkspacePath('/workspace')).toBe('/workspace');
  });

  it('strips "." segments', () => {
    expect(resolveWorkspacePath('/workspace/./foo/./bar')).toBe('/workspace/foo/bar');
  });

  it('resolves relative "." to /workspace', () => {
    expect(resolveWorkspacePath('.')).toBe('/workspace');
  });

  it('resolves deeply nested relative path', () => {
    expect(resolveWorkspacePath('a/b/c/d')).toBe('/workspace/a/b/c/d');
  });

  // --- Invalid paths that should be rejected (return null) ---

  it('rejects path traversal escaping /workspace via ..', () => {
    expect(resolveWorkspacePath('/workspace/../etc/passwd')).toBeNull();
  });

  it('rejects deep traversal escaping /workspace', () => {
    expect(resolveWorkspacePath('/workspace/a/b/../../../../etc/shadow')).toBeNull();
  });

  it('rejects absolute path outside /workspace', () => {
    expect(resolveWorkspacePath('/etc/passwd')).toBeNull();
  });

  it('rejects relative path with traversal escaping /workspace', () => {
    expect(resolveWorkspacePath('../../etc/passwd')).toBeNull();
  });

  it('rejects root path /', () => {
    expect(resolveWorkspacePath('/')).toBeNull();
  });

  it('rejects /workspacefoo (prefix match but not a real subdirectory)', () => {
    expect(resolveWorkspacePath('/workspacefoo/bar')).toBeNull();
  });

  it('rejects /tmp', () => {
    expect(resolveWorkspacePath('/tmp')).toBeNull();
  });

  it('rejects /root/.ssh/authorized_keys', () => {
    expect(resolveWorkspacePath('/root/.ssh/authorized_keys')).toBeNull();
  });
});
