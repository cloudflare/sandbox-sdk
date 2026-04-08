import { describe, expect, it, vi } from 'vitest';

// Mock @cloudflare/sandbox to avoid importing the real module which requires
// native Cloudflare container bindings that aren't available in plain Node.
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  proxyToSandbox: vi.fn(async () => null),
  Sandbox: class {}
}));

const { shellQuote } = await import('../index');

describe('shellQuote', () => {
  it('returns safe alphanumeric tokens unchanged', () => {
    expect(shellQuote('hello')).toBe('hello');
  });

  it('returns paths with slashes unchanged (safe chars)', () => {
    expect(shellQuote('/workspace/foo')).toBe('/workspace/foo');
  });

  it('returns paths with dots and hyphens unchanged', () => {
    expect(shellQuote('./some-dir/file.tar')).toBe('./some-dir/file.tar');
  });

  it('wraps strings with spaces in single quotes', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
  });

  it("escapes interior single quotes as '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('wraps strings with semicolons (shell metachar)', () => {
    expect(shellQuote('foo;rm -rf /')).toBe("'foo;rm -rf /'");
  });

  it('wraps strings with backticks', () => {
    expect(shellQuote('foo`whoami`')).toBe("'foo`whoami`'");
  });

  it('wraps strings with $() command substitution', () => {
    expect(shellQuote('$(evil)')).toBe("'$(evil)'");
  });

  it('wraps strings with pipe characters', () => {
    expect(shellQuote('a|b')).toBe("'a|b'");
  });

  it('wraps strings with ampersand', () => {
    expect(shellQuote('a&b')).toBe("'a&b'");
  });

  it('handles empty string', () => {
    // Empty string doesn't match the safe-char regex, so gets quoted
    expect(shellQuote('')).toBe("''");
  });
});
