import { describe, expect, it } from 'vitest';
import { detectCredentials } from '../../src/storage-mount/credential-detection';

describe('Credential Detection', () => {
  it('should use explicit credentials from options', () => {
    const envVars = {};
    const options = {
      endpoint: 'https://test.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: 'explicit-key',
        secretAccessKey: 'explicit-secret'
      }
    };

    const credentials = detectCredentials(options, envVars);

    expect(credentials.accessKeyId).toBe('explicit-key');
    expect(credentials.secretAccessKey).toBe('explicit-secret');
  });

  it('should detect standard AWS env vars', () => {
    const envVars = {
      AWS_ACCESS_KEY_ID: 'aws-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret'
    };
    const options = { endpoint: 'https://s3.us-west-2.amazonaws.com' };

    const credentials = detectCredentials(options, envVars);

    expect(credentials.accessKeyId).toBe('aws-key');
    expect(credentials.secretAccessKey).toBe('aws-secret');
  });

  it('should include session token if present', () => {
    const envVars = {
      AWS_ACCESS_KEY_ID: 'aws-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_SESSION_TOKEN: 'session-token'
    };
    const options = { endpoint: 'https://s3.us-west-2.amazonaws.com' };

    const credentials = detectCredentials(options, envVars);

    expect(credentials.sessionToken).toBe('session-token');
  });

  it('should prioritize explicit credentials over env vars', () => {
    const envVars = {
      AWS_ACCESS_KEY_ID: 'env-key',
      AWS_SECRET_ACCESS_KEY: 'env-secret'
    };
    const options = {
      endpoint: 'https://test.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: 'explicit-key',
        secretAccessKey: 'explicit-secret'
      }
    };

    const credentials = detectCredentials(options, envVars);

    expect(credentials.accessKeyId).toBe('explicit-key');
    expect(credentials.secretAccessKey).toBe('explicit-secret');
  });

  it('should throw error when no credentials found', () => {
    const envVars = {};
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    expect(() => detectCredentials(options, envVars)).toThrow(
      'No credentials found'
    );
  });

  it('should include helpful error message with env var hints', () => {
    const envVars = {};
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    let thrownError: Error | null = null;
    try {
      detectCredentials(options, envVars);
    } catch (error) {
      thrownError = error as Error;
    }

    expect(thrownError).toBeTruthy();
    if (thrownError) {
      const message = thrownError.message;
      expect(message).toContain('AWS_ACCESS_KEY_ID');
      expect(message).toContain('AWS_SECRET_ACCESS_KEY');
      expect(message).toContain('explicit credentials');
    }
  });

  it('should throw error when only access key is present', () => {
    const envVars = {
      AWS_ACCESS_KEY_ID: 'aws-key'
      // Missing AWS_SECRET_ACCESS_KEY
    };
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    expect(() => detectCredentials(options, envVars)).toThrow(
      'No credentials found'
    );
  });

  it('should throw error when only secret key is present', () => {
    const envVars = {
      AWS_SECRET_ACCESS_KEY: 'aws-secret'
      // Missing AWS_ACCESS_KEY_ID
    };
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    expect(() => detectCredentials(options, envVars)).toThrow(
      'No credentials found'
    );
  });
});
