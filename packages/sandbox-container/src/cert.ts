import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createLogger } from '@repo/shared';

const logger = createLogger({ component: 'container' });

const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const CERT_WAIT_TIMEOUT_MS = 5000;
const CERT_WAIT_POLL_MS = 100;

async function waitForCertFile(certPath: string): Promise<boolean> {
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
    logger.warn(
      'Certificate not found, could not enable HTTPS intercept support'
    );
    return;
  }

  const certContent = readFileSync(certPath, 'utf8');
  appendFileSync(SYSTEM_CA_BUNDLE, `\n${certContent}`);

  // NODE_EXTRA_CA_CERTS is additive in Node/Bun; the rest replace the default
  // store entirely, so they must point to the full bundle.
  process.env.NODE_EXTRA_CA_CERTS = certPath;
  process.env.SSL_CERT_FILE = SYSTEM_CA_BUNDLE;
  process.env.CURL_CA_BUNDLE = SYSTEM_CA_BUNDLE;
  process.env.REQUESTS_CA_BUNDLE = SYSTEM_CA_BUNDLE;
  process.env.GIT_SSL_CAINFO = SYSTEM_CA_BUNDLE;
}
