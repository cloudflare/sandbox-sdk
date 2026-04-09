import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createLogger } from '@repo/shared';

const logger = createLogger({ component: 'container' });

const SYSTEM_CA_BUNDLE_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Alpine, Arch
  '/etc/pki/tls/certs/ca-bundle.crt', // Fedora, RHEL, CentOS
  '/etc/ssl/ca-bundle.pem', // SUSE and openSUSE
  '/etc/ssl/cert.pem', // Alpine and OpenSSL-compatible bundle symlink
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL-family extracted PEM bundle
  '/etc/pki/tls/cert.pem' // Older RHEL-family compatibility bundle
];
const CERT_WAIT_TIMEOUT_MS = 5000;
const CERT_WAIT_POLL_MS = 100;

function findSystemBundle(): string | undefined {
  return SYSTEM_CA_BUNDLE_PATHS.find((bundlePath) => existsSync(bundlePath));
}

async function waitForCertFile(certPath: string): Promise<boolean> {
  if (existsSync(certPath)) return true;

  const deadline = Date.now() + CERT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(certPath)) return true;
    await Bun.sleep(CERT_WAIT_POLL_MS);
  }
  return false;
}

export async function trustRuntimeCert(): Promise<void> {
  // Default to the Cloudflare containers injected CA certificate
  const certPath =
    process.env.SANDBOX_CA_CERT ||
    '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
  if (!(await waitForCertFile(certPath))) {
    logger.error(
      'Certificate not found, refusing to start without HTTPS interception enabled'
    );
    process.exit(1);
  }

  let certContent: string;
  try {
    certContent = readFileSync(certPath, 'utf8');
  } catch (error) {
    logger.error(
      `Failed to read runtime certificate, refusing to start without HTTPS interception enabled`,
      error instanceof Error ? error : new Error(String(error))
    );
    process.exit(1);
  }

  process.env.NODE_EXTRA_CA_CERTS = certPath;

  const systemBundlePath = findSystemBundle();
  if (!systemBundlePath) {
    logger.warn('No supported system CA bundle found', {
      checkedPaths: SYSTEM_CA_BUNDLE_PATHS
    });
    return;
  }

  try {
    appendFileSync(systemBundlePath, `\n${certContent}`);
  } catch (error) {
    logger.error(
      `Failed to append runtime certificate, refusing to start without HTTPS interception enabled`,
      error instanceof Error ? error : new Error(String(error))
    );
    process.exit(1);
  }

  // NODE_EXTRA_CA_CERTS is additive in Node/Bun; the rest replace the default
  // store entirely, so they must point to the full bundle.
  process.env.SSL_CERT_FILE = systemBundlePath;
  process.env.CURL_CA_BUNDLE = systemBundlePath;
  process.env.REQUESTS_CA_BUNDLE = systemBundlePath;
  process.env.GIT_SSL_CAINFO = systemBundlePath;
}
