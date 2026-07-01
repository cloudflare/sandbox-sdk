import { Sandbox as BaseSandbox, type getSandbox } from '@cloudflare/sandbox';
import { credentialsHandler } from './credentials';

/**
 * Sandbox Durable Object with an outbound interceptor for the credential
 * vending host (see `CREDENTIALS_HOST` below). The interceptor catches the
 * request inside the Worker isolate and serves STS-backed credentials
 * directly — the credential payload never leaves Cloudflare's network.
 */
export class Sandbox extends BaseSandbox {}

// The credential vending hostname. mount-s3's AWS CRT special-cases the ECS
// task metadata IP (169.254.170.2) as a trusted host for credential fetching
// and permits plain HTTP. The Sandbox DO's outboundByHost interceptor catches
// the request inside the Worker isolate before it ever hits the network, so the
// credential payload never traverses any wire. Changing this value also requires
// updating AWS_CONTAINER_CREDENTIALS_FULL_URI in the mount-s3 environment below.
export const CREDENTIALS_HOST = '169.254.170.2';
export const CREDENTIALS_URI = `http://${CREDENTIALS_HOST}/`;

Sandbox.outboundByHost = {
  [CREDENTIALS_HOST]: credentialsHandler
};

// ---------------------------------------------------------------------------
// Sandbox lifecycle helpers
// ---------------------------------------------------------------------------

export type MountResult =
  | { ok: true; status: 'mounted' | 'already-mounted' }
  | { ok: false; error: string; diagnostics?: string };

/**
 * Mount the configured S3 bucket at /mnt/s3 inside the given sandbox.
 * Idempotent — returns 'already-mounted' if the FUSE mount is already live.
 * Polls up to 10s for the mount to become live, then returns a structured result.
 */
export async function mountBucket(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<MountResult> {
  // Idempotent: skip if already mounted
  const mountCheck = await sandbox
    .exec('(mountpoint -q /mnt/s3 && echo mounted || echo not-mounted)')
    .text();
  if (mountCheck.trim() === 'mounted') {
    return { ok: true, status: 'already-mounted' };
  }

  // Verify /dev/fuse is available before attempting the mount
  const fuseCheck = await sandbox
    .exec('(test -c /dev/fuse && echo ok || echo missing)')
    .text();
  if (fuseCheck.trim() !== 'ok') {
    return { ok: false, error: '/dev/fuse is not available in this container' };
  }

  // The AWS CRT reads AWS_CONTAINER_CREDENTIALS_FULL_URI on startup and every
  // time it needs to refresh credentials. See CREDENTIALS_URI above for why a
  // bare HTTP URL is safe here.

  // mount-s3 --foreground runs indefinitely. startProcess() launches it as a
  // managed background process and returns immediately.
  const mountCmd = [
    'mount-s3',
    env.S3_BUCKET_NAME,
    '/mnt/s3',
    '--region',
    env.AWS_REGION,
    '--allow-delete',
    '--allow-overwrite',
    '--foreground'
  ].join(' ');

  await sandbox.exec(mountCmd, {
    env: {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: CREDENTIALS_URI,
      AWS_REGION: env.AWS_REGION
    },
    processId: 'mount-s3',
    autoCleanup: false
  });

  // Poll until the mount is live (up to 10 seconds)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const poll = await sandbox
      .exec('(mountpoint -q /mnt/s3 && echo mounted || echo not-mounted)')
      .text();
    if (poll.trim() === 'mounted') {
      await installShellAutoCd(sandbox);
      return { ok: true, status: 'mounted' };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  const diag = await sandbox
    .exec('(ls -la /dev/fuse; dmesg 2>/dev/null | tail -5 || true)')
    .text();
  return { ok: false, error: 'mount timed out', diagnostics: diag };
}

/**
 * Drop a one-liner into ~/.bashrc that lands new interactive shells in
 * /mnt/s3. The PTY proxy spawns bash interactively, so bash sources ~/.bashrc
 * automatically — no terminal() option needed. Idempotent via a marker comment.
 */
const BASHRC_MARKER = '# sandbox-s3-mount auto-cd';
async function installShellAutoCd(
  sandbox: ReturnType<typeof getSandbox>
): Promise<void> {
  // Only cd when the shell is starting in $HOME; respect any explicit cd a
  // caller might do before spawning a sub-shell. `2>/dev/null` keeps the cd
  // failure quiet if /mnt/s3 ever goes away under us.
  const snippet = [
    BASHRC_MARKER,
    'if [ -d /mnt/s3 ] && [ "$PWD" = "$HOME" ]; then cd /mnt/s3 2>/dev/null; fi'
  ].join('\n');
  await sandbox
    .exec(
      `grep -qF ${shellQuote(BASHRC_MARKER)} ~/.bashrc 2>/dev/null || printf '%s\n' ${shellQuote(snippet)} >> ~/.bashrc`
    )
    .output();
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Unmount the S3 bucket from /mnt/s3 in the given sandbox. Best-effort: the
 * sandbox base image ships /etc/mtab so `fusermount -u` is the supported path.
 * Any failure is swallowed because the DO is being torn down anyway — this just
 * gives mount-s3 a chance to flush pending writes before the container exits.
 */
export async function unmountBucket(
  sandbox: ReturnType<typeof getSandbox>
): Promise<void> {
  // Subshell so a non-zero exit doesn't poison the default session.
  await sandbox.exec('(fusermount -u /mnt/s3 2>&1 || true)').output();
}
