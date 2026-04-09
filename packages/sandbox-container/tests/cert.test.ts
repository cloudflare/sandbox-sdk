import { beforeEach, describe, expect, it, mock, vi } from 'bun:test';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockAppendFileSync = vi.fn();

mock.module('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync
}));

import { trustRuntimeCert } from '../src/cert';

const DEFAULT_CERT_PATH = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const PRIMARY_SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const FALLBACK_SYSTEM_CA_BUNDLE = '/etc/pki/tls/certs/ca-bundle.crt';

const mockProcessExit = vi
  .spyOn(process, 'exit')
  .mockImplementation((): never => {
    throw new Error('process.exit');
  });

describe('trustRuntimeCert', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockAppendFileSync.mockReset();
    mockProcessExit.mockClear();
    delete process.env.SANDBOX_CA_CERT;
    delete process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.SSL_CERT_FILE;
    delete process.env.CURL_CA_BUNDLE;
    delete process.env.REQUESTS_CA_BUNDLE;
    delete process.env.GIT_SSL_CAINFO;
  });

  it('exits with code 1 when the cert file is not found', async () => {
    mockExistsSync.mockReturnValue(false);
    const sleepSpy = vi.spyOn(Bun, 'sleep').mockResolvedValue();
    const dateSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(10_000);

    try {
      await trustRuntimeCert();
    } catch {
      // expected — process.exit mock throws to halt execution
    } finally {
      sleepSpy.mockRestore();
      dateSpy.mockRestore();
    }

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('exits with code 1 when reading the runtime cert fails', async () => {
    mockExistsSync.mockImplementation(
      (path: string) => path === DEFAULT_CERT_PATH
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) {
        throw new Error('read failed');
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    try {
      await trustRuntimeCert();
    } catch {
      // expected — process.exit mock throws to halt execution
    }

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('appends the cert content to the default system bundle when it exists', async () => {
    const certContent =
      '-----BEGIN CERTIFICATE-----\nABCDEF\n-----END CERTIFICATE-----\n';
    mockExistsSync.mockImplementation((path: string) =>
      [DEFAULT_CERT_PATH, PRIMARY_SYSTEM_CA_BUNDLE].includes(path)
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return certContent;
      throw new Error(`Unexpected path: ${path}`);
    });

    await trustRuntimeCert();

    expect(mockReadFileSync).toHaveBeenCalledWith(DEFAULT_CERT_PATH, 'utf8');
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      PRIMARY_SYSTEM_CA_BUNDLE,
      `\n${certContent}`
    );
  });

  it('exits with code 1 when appending to the system bundle fails', async () => {
    mockExistsSync.mockImplementation((path: string) =>
      [DEFAULT_CERT_PATH, PRIMARY_SYSTEM_CA_BUNDLE].includes(path)
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return 'cert-content';
      throw new Error(`Unexpected path: ${path}`);
    });
    mockAppendFileSync.mockImplementation(() => {
      throw new Error('append failed');
    });

    try {
      await trustRuntimeCert();
    } catch {
      // expected — process.exit mock throws to halt execution
    }

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(process.env.SSL_CERT_FILE).toBeUndefined();
    expect(process.env.CURL_CA_BUNDLE).toBeUndefined();
    expect(process.env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined();
  });

  it('uses the first supported fallback system bundle path that exists', async () => {
    const certContent = 'cert-content';
    mockExistsSync.mockImplementation((path: string) =>
      [DEFAULT_CERT_PATH, FALLBACK_SYSTEM_CA_BUNDLE].includes(path)
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return certContent;
      throw new Error(`Unexpected path: ${path}`);
    });

    await trustRuntimeCert();

    expect(mockAppendFileSync).toHaveBeenCalledWith(
      FALLBACK_SYSTEM_CA_BUNDLE,
      `\n${certContent}`
    );
  });

  it('sets env vars to the detected system bundle when a supported system bundle exists', async () => {
    mockExistsSync.mockImplementation((path: string) =>
      [DEFAULT_CERT_PATH, PRIMARY_SYSTEM_CA_BUNDLE].includes(path)
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return 'cert-content';
      throw new Error(`Unexpected path: ${path}`);
    });

    await trustRuntimeCert();

    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(DEFAULT_CERT_PATH);
    expect(process.env.SSL_CERT_FILE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.CURL_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.GIT_SSL_CAINFO).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
  });

  it('sets only NODE_EXTRA_CA_CERTS when no supported system bundle exists', async () => {
    process.env.SSL_CERT_FILE = '/tmp/existing-ssl-cert-file';
    process.env.CURL_CA_BUNDLE = '/tmp/existing-curl-ca-bundle';
    process.env.REQUESTS_CA_BUNDLE = '/tmp/existing-requests-ca-bundle';
    process.env.GIT_SSL_CAINFO = '/tmp/existing-git-ssl-cainfo';
    mockExistsSync.mockImplementation(
      (path: string) => path === DEFAULT_CERT_PATH
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return 'cert-content';
      throw new Error(`Unexpected path: ${path}`);
    });

    await trustRuntimeCert();

    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(DEFAULT_CERT_PATH);
    expect(process.env.SSL_CERT_FILE).toBe('/tmp/existing-ssl-cert-file');
    expect(process.env.CURL_CA_BUNDLE).toBe('/tmp/existing-curl-ca-bundle');
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(
      '/tmp/existing-requests-ca-bundle'
    );
    expect(process.env.GIT_SSL_CAINFO).toBe('/tmp/existing-git-ssl-cainfo');
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('uses SANDBOX_CA_CERT env var instead of the default path', async () => {
    const customPath = '/tmp/my-corp-ca.crt';
    process.env.SANDBOX_CA_CERT = customPath;
    mockExistsSync.mockImplementation((path: string) =>
      [customPath, PRIMARY_SYSTEM_CA_BUNDLE].includes(path)
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === customPath) return 'cert-content';
      if (path === PRIMARY_SYSTEM_CA_BUNDLE) return 'system-ca\n';
      throw new Error(`Unexpected path: ${path}`);
    });

    await trustRuntimeCert();

    expect(mockExistsSync).toHaveBeenCalledWith(customPath);
    expect(mockReadFileSync).toHaveBeenCalledWith(customPath, 'utf8');
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(customPath);
    expect(process.env.SSL_CERT_FILE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
  });
});
