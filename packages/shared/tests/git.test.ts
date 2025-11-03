import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/git';

describe('redactCredentials', () => {
  it('should redact credentials and preserve public URLs', () => {
    // Credentials with username:password format
    expect(redactCredentials('https://user:token123@github.com/repo.git'))
      .toBe('https://******@github.com/repo.git');

    // Token without username (different format)
    expect(redactCredentials('https://ghp_token456@github.com/org/project.git'))
      .toBe('https://******@github.com/org/project.git');

    // Public URLs without credentials
    expect(redactCredentials('https://github.com/facebook/react.git'))
      .toBe('https://github.com/facebook/react.git');

    // SSH URLs (different format, @ not after protocol)
    expect(redactCredentials('git@github.com:user/repo.git'))
      .toBe('git@github.com:user/repo.git');
  });
});
