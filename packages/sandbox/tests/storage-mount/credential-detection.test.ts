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

  it('should detect standard R2 env vars', () => {
    const envVars = {
      R2_ACCESS_KEY_ID: 'r2-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret'
    };
    const options = { endpoint: 'https://s3.us-west-2.amazonaws.com' };

    const credentials = detectCredentials(options, envVars);

    expect(credentials.accessKeyId).toBe('r2-key');
    expect(credentials.secretAccessKey).toBe('r2-secret');
  });

  it('should ignore session token in environment', () => {
    const envVars = {
      AWS_ACCESS_KEY_ID: 'aws-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_SESSION_TOKEN: 'session-token'
    };
    const options = { endpoint: 'https://s3.us-west-2.amazonaws.com' };

    const credentials = detectCredentials(options, envVars);

    expect(credentials.accessKeyId).toBe('aws-key');
    expect(credentials.secretAccessKey).toBe('aws-secret');
  });

  it('should prioritize explicit credentials over env vars', () => {
    const envVars = {
      AWS_ACCESS_KEY_ID: 'env-key',
      AWS_SECRET_ACCESS_KEY: 'env-secret',
      R2_ACCESS_KEY_ID: 'r2-env-key',
      R2_SECRET_ACCESS_KEY: 'r2-env-secret'
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
      expect(message).toContain('R2_ACCESS_KEY_ID');
      expect(message).toContain('R2_SECRET_ACCESS_KEY');
      expect(message).toContain('AWS_ACCESS_KEY_ID');
      expect(message).toContain('AWS_SECRET_ACCESS_KEY');
      expect(message).toContain('explicit credentials');
    }
  });

  it('should throw error when only AWS access key is present', () => {
    const envVars = {
      AWS_ACCESS_KEY_ID: 'aws-key'
      // Missing AWS_SECRET_ACCESS_KEY
    };
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    expect(() => detectCredentials(options, envVars)).toThrow(
      'No credentials found'
    );
  });

  it('should throw error when only AWS secret key is present', () => {
    const envVars = {
      AWS_SECRET_ACCESS_KEY: 'aws-secret'
      // Missing AWS_ACCESS_KEY_ID
    };
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    expect(() => detectCredentials(options, envVars)).toThrow(
      'No credentials found'
    );
  });

  it('should throw error when only R2 access key is present', () => {
    const envVars = {
      R2_ACCESS_KEY_ID: 'r2-key'
      // Missing R2_SECRET_ACCESS_KEY
    };
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    expect(() => detectCredentials(options, envVars)).toThrow(
      'No credentials found'
    );
  });

  it('should throw error when only R2 secret key is present', () => {
    const envVars = {
      R2_SECRET_ACCESS_KEY: 'r2-secret'
      // Missing R2_ACCESS_KEY_ID
    };
    const options = { endpoint: 'https://test.r2.cloudflarestorage.com' };

    expect(() => detectCredentials(options, envVars)).toThrow(
      'No credentials found'
    );
  });
});
