import { describe, expect, it } from 'vitest';
import { shellQuote } from '../../../../packages/sandbox/src/bridge/helpers';

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

  it("wraps strings with spaces in $'...' quoting", () => {
    expect(shellQuote('hello world')).toBe("$'hello world'");
  });

  it('escapes interior single quotes', () => {
    expect(shellQuote("it's")).toBe("$'it\\'s'");
  });

  it('wraps strings with semicolons (shell metachar)', () => {
    expect(shellQuote('foo;rm -rf /')).toBe("$'foo;rm -rf /'");
  });

  it('wraps strings with backticks', () => {
    expect(shellQuote('foo`whoami`')).toBe("$'foo`whoami`'");
  });

  it('wraps strings with $() command substitution', () => {
    expect(shellQuote('$(evil)')).toBe("$'$(evil)'");
  });

  it('wraps strings with pipe characters', () => {
    expect(shellQuote('a|b')).toBe("$'a|b'");
  });

  it('wraps strings with ampersand', () => {
    expect(shellQuote('a&b')).toBe("$'a&b'");
  });

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("$''");
  });

  it('escapes newlines', () => {
    expect(shellQuote('line1\nline2')).toBe("$'line1\\nline2'");
  });

  it('escapes carriage returns', () => {
    expect(shellQuote('a\rb')).toBe("$'a\\rb'");
  });

  it('escapes tabs', () => {
    expect(shellQuote('a\tb')).toBe("$'a\\tb'");
  });

  it('escapes backslashes', () => {
    expect(shellQuote('a\\b')).toBe("$'a\\\\b'");
  });

  it('handles combined special characters', () => {
    expect(shellQuote("it's a\nnew line")).toBe("$'it\\'s a\\nnew line'");
  });
});
