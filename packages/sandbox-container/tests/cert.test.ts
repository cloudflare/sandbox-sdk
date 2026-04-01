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

const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const DEFAULT_CERT_PATH = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

describe('trustRuntimeCert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SANDBOX_CA_CERT;
    delete process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.SSL_CERT_FILE;
    delete process.env.CURL_CA_BUNDLE;
    delete process.env.REQUESTS_CA_BUNDLE;
    delete process.env.GIT_SSL_CAINFO;
  });

  it('does nothing when the cert file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const sleepSpy = vi.spyOn(Bun, 'sleep').mockResolvedValue();
    const dateSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(10_000);

    try {
      await trustRuntimeCert();
    } finally {
      sleepSpy.mockRestore();
      dateSpy.mockRestore();
    }

    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('does not set env vars when the cert file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const sleepSpy = vi.spyOn(Bun, 'sleep').mockResolvedValue();
    const dateSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(10_000);

    try {
      await trustRuntimeCert();
    } finally {
      sleepSpy.mockRestore();
      dateSpy.mockRestore();
    }

    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(process.env.SSL_CERT_FILE).toBeUndefined();
    expect(process.env.CURL_CA_BUNDLE).toBeUndefined();
    expect(process.env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined();
  });

  it('appends cert content to the system bundle when the cert file exists', async () => {
    const certContent =
      '-----BEGIN CERTIFICATE-----\nABCDEF\n-----END CERTIFICATE-----\n';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(certContent);

    await trustRuntimeCert();

    expect(mockReadFileSync).toHaveBeenCalledWith(DEFAULT_CERT_PATH, 'utf8');
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      SYSTEM_CA_BUNDLE,
      `\n${certContent}`
    );
  });

  it('sets all env vars to the correct paths when cert file exists', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('cert-content');

    await trustRuntimeCert();

    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(DEFAULT_CERT_PATH);
    expect(process.env.SSL_CERT_FILE).toBe(SYSTEM_CA_BUNDLE);
    expect(process.env.CURL_CA_BUNDLE).toBe(SYSTEM_CA_BUNDLE);
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(SYSTEM_CA_BUNDLE);
    expect(process.env.GIT_SSL_CAINFO).toBe(SYSTEM_CA_BUNDLE);
  });

  it('uses SANDBOX_CA_CERT env var instead of the default path', async () => {
    const customPath = '/tmp/my-corp-ca.crt';
    process.env.SANDBOX_CA_CERT = customPath;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('cert-content');

    await trustRuntimeCert();

    expect(mockExistsSync).toHaveBeenCalledWith(customPath);
    expect(mockReadFileSync).toHaveBeenCalledWith(customPath, 'utf8');
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(customPath);
  });
});
