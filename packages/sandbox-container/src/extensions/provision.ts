import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ExtensionRegistration, Logger } from '@repo/shared';

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 120_000;
const INSTALL_OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * Inputs to {@link provisionPackage}. The host already knows the tarball
 * bytes and the directory it wants to provision into; `bin` and other
 * overrides come from the SDK-side `ExtensionPackage`.
 */
export interface ProvisionInput {
  tarballBytes: Uint8Array;
  packageHash: string;
  /** Provisioned directory (e.g. `/var/lib/sandbox-extensions/<hash>`). */
  dir: string;
  /** Override for `package.json#sandboxExtension.bin` (multi-bin packages). */
  binOverride?: string;
  /** Override for `package.json#sandboxExtension.readinessTimeoutMs`. */
  readinessTimeoutMsOverride?: number;
  /** Run lifecycle scripts during `bun add` (defaults to false). */
  allowInstallScripts?: boolean;
  logger: Logger;
}

export interface ProvisionResult {
  registration: ExtensionRegistration;
  /** Absolute path to the spawnable bin entry inside the provisioned dir. */
  binAbsolutePath: string;
}

/**
 * Shape of the metadata block we expect inside an extension's `package.json`.
 * Authors put any extension-specific configuration under this key; the host
 * never reads top-level package.json keys other than `name`, `version`,
 * `bin`, and `sandboxExtension`.
 */
interface SandboxExtensionPackageJson {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
  sandboxExtension?: {
    bin?: string;
    readinessTimeoutMs?: number;
  };
}

/**
 * Compute the hex sha256 of a tarball. Used as the provision idempotency key
 * \u2014 any byte change reprovisions, even at the same package version.
 */
export function hashTarball(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Provision an extension package on disk.
 *
 * Steps:
 *  1. Write `extension.tgz` into `dir`.
 *  2. Read `package/package.json` from the tarball (no subprocess).
 *  3. Derive the registration (slug id, version, bin, readiness timeout).
 *  4. `bun add --ignore-scripts ./extension.tgz` to materialise
 *     `node_modules/<name>/...` and any `node_modules/.bin/` shims.
 *
 * Idempotent: callers must only invoke this when the host does not already
 * hold an `ExtensionInstance` for `packageHash`.
 */
export async function provisionPackage(
  input: ProvisionInput
): Promise<ProvisionResult> {
  await mkdir(input.dir, { recursive: true });
  const tarballPath = join(input.dir, 'extension.tgz');
  // Bun-native I/O on purpose: the container is always Bun, and this avoids
  // any test-suite `mock.module('node:fs')` interference.
  await Bun.write(tarballPath, input.tarballBytes);

  const packageJson = readPackageJsonFromTarball(input.tarballBytes);
  const registration = deriveRegistration(packageJson, input);

  input.logger.debug('Installing extension package', {
    packageHash: input.packageHash,
    name: registration.packageName,
    version: registration.version,
    dir: input.dir
  });

  await runBunAdd(input.dir, input.allowInstallScripts === true);

  const binTarget = resolveBinTarget(packageJson, registration.bin);
  const binAbsolutePath = join(
    input.dir,
    'node_modules',
    registration.packageName,
    binTarget
  );

  if (!(await Bun.file(binAbsolutePath).exists())) {
    throw new Error(
      `Extension '${registration.id}' bin '${registration.bin}' did not resolve to ${binAbsolutePath} after install`
    );
  }

  return { registration, binAbsolutePath };
}

function deriveRegistration(
  pkg: SandboxExtensionPackageJson,
  input: ProvisionInput
): ExtensionRegistration {
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    throw new Error('Extension package.json must declare a non-empty name');
  }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(
      `Extension '${pkg.name}' package.json must declare a non-empty version`
    );
  }

  const id = slugifyPackageName(pkg.name);
  if (!SLUG_PATTERN.test(id)) {
    throw new Error(
      `Extension package name '${pkg.name}' produces an invalid slug '${id}'`
    );
  }

  const bin = chooseBinName(pkg, input.binOverride);
  const readinessTimeoutMs =
    input.readinessTimeoutMsOverride ??
    pkg.sandboxExtension?.readinessTimeoutMs ??
    DEFAULT_READINESS_TIMEOUT_MS;

  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new Error(
      `Extension '${id}' readinessTimeoutMs must be a positive number`
    );
  }

  return {
    id,
    packageName: pkg.name,
    version: pkg.version,
    packageHash: input.packageHash,
    bin,
    readinessTimeoutMs
  };
}

/**
 * Slugify an npm package name into a filesystem/identifier-safe id.
 *
 * `@acme/foo` \u2192 `acme-foo`. We keep dots/underscores/hyphens intact and
 * collapse path separators introduced by the scope prefix.
 */
function slugifyPackageName(name: string): string {
  return name.replace(/^@/, '').replace(/\//g, '-');
}

function chooseBinName(
  pkg: SandboxExtensionPackageJson,
  override: string | undefined
): string {
  if (override) return override;
  if (pkg.sandboxExtension?.bin) return pkg.sandboxExtension.bin;

  if (typeof pkg.bin === 'string') {
    // String form means there's a single bin whose name defaults to the
    // (unscoped) package name. Match what `bun add` does for `node_modules/.bin`.
    return slugifyPackageName(pkg.name);
  }

  if (pkg.bin && typeof pkg.bin === 'object') {
    const names = Object.keys(pkg.bin);
    if (names.length === 0) {
      throw new Error(
        `Extension '${pkg.name}' package.json declares no bin entries`
      );
    }
    if (names.length === 1) return names[0];
    throw new Error(
      `Extension '${pkg.name}' declares multiple bins (${names.join(
        ', '
      )}); set 'sandboxExtension.bin' or pass 'bin' in the ExtensionPackage`
    );
  }

  throw new Error(
    `Extension '${pkg.name}' package.json must declare a 'bin' entry`
  );
}

function resolveBinTarget(
  pkg: SandboxExtensionPackageJson,
  binName: string
): string {
  if (typeof pkg.bin === 'string') {
    return normaliseBinPath(pkg.bin);
  }
  if (pkg.bin && typeof pkg.bin === 'object') {
    const target = pkg.bin[binName];
    if (typeof target !== 'string') {
      throw new Error(
        `Extension '${pkg.name}' bin '${binName}' is not declared in package.json`
      );
    }
    return normaliseBinPath(target);
  }
  throw new Error(
    `Extension '${pkg.name}' package.json declares no bin entry to resolve`
  );
}

function normaliseBinPath(target: string): string {
  // Strip leading "./" so we can join cleanly under node_modules/<name>.
  return target.replace(/^\.\//, '');
}

/**
 * Read `package/package.json` from an npm-style tarball. Tarballs produced by
 * `npm pack` / `bun pm pack` always nest contents under a `package/` prefix.
 *
 * Implemented in-process to avoid shelling out to `tar` and to keep the host
 * runtime independent of the container image's userland tools.
 */
function readPackageJsonFromTarball(
  tarballBytes: Uint8Array
): SandboxExtensionPackageJson {
  const inflated = gunzipSync(tarballBytes);
  const entry = findTarEntry(inflated, 'package/package.json');
  if (!entry) {
    throw new Error(
      "Extension tarball does not contain 'package/package.json'"
    );
  }
  const json = Buffer.from(entry).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Extension tarball package.json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Extension tarball package.json must be a JSON object');
  }
  return parsed as SandboxExtensionPackageJson;
}

const TAR_BLOCK_SIZE = 512;

/**
 * Minimal POSIX/ustar tar reader. Returns the bytes of the first regular-file
 * entry whose name matches `targetName` (after long-name prefix handling).
 *
 * Handles:
 *  - regular files (`typeflag` `'0'` or `'\0'`),
 *  - long file names emitted by GNU tar as a `'L'` header preceding the real entry.
 *
 * Does not attempt to handle sparse files, hard/symlinks, or extended PAX
 * headers \u2014 npm-produced tarballs never contain them.
 */
function findTarEntry(
  buffer: Buffer,
  targetName: string
): Uint8Array | undefined {
  let offset = 0;
  let nextLongName: string | undefined;
  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header[0] === 0) break; // Two consecutive zero blocks signal end of archive.
    const name = readTarString(header, 0, 100);
    const sizeOctal = readTarString(header, 124, 12);
    const size = sizeOctal ? Number.parseInt(sizeOctal.trim(), 8) : 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = readTarString(header, 345, 155);

    offset += TAR_BLOCK_SIZE;
    const dataLength = Number.isFinite(size) ? size : 0;
    const data = buffer.subarray(offset, offset + dataLength);
    offset += alignTo(dataLength, TAR_BLOCK_SIZE);

    if (typeflag === 'L') {
      // GNU long-name extension: next header's name is the data of this one.
      nextLongName = Buffer.from(data).toString('utf8').replace(/\0+$/, '');
      continue;
    }

    const entryName = nextLongName ?? (prefix ? `${prefix}/${name}` : name);
    nextLongName = undefined;

    if (
      (typeflag === '0' || typeflag === '\u0000') &&
      entryName === targetName
    ) {
      return data;
    }
  }
  return undefined;
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function alignTo(value: number, block: number): number {
  const remainder = value % block;
  return remainder === 0 ? value : value + (block - remainder);
}

/**
 * Run `bun add ./extension.tgz` inside the provisioned dir. The local-path
 * spec triggers `bun`'s normal install machinery: dependency resolution (a
 * no-op for pre-bundled sidecars), `node_modules/<name>` materialisation,
 * and `node_modules/.bin/` shim creation.
 *
 * Lifecycle scripts are skipped unless `allowInstallScripts` is true \u2014
 * provisioning runs before sidecar supervision, so install-time side effects
 * are deliberately opt-in.
 */
async function runBunAdd(
  cwd: string,
  allowInstallScripts: boolean
): Promise<void> {
  const args = ['add', './extension.tgz', '--no-summary'];
  if (!allowInstallScripts) args.push('--ignore-scripts');
  const child = Bun.spawn({
    cmd: ['bun', ...args],
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Defensive: prevent bun from interactively prompting for trust on
      // newly seen scripts. With --ignore-scripts this is moot; with
      // allowInstallScripts=true we still want non-interactive behaviour.
      BUN_INSTALL_SKIP_TRUST_PROMPT: '1'
    }
  });

  const stderrPromise = readLimited(
    child.stderr as ReadableStream<Uint8Array>,
    INSTALL_OUTPUT_LIMIT_BYTES
  );
  const stdoutPromise = readLimited(
    child.stdout as ReadableStream<Uint8Array>,
    INSTALL_OUTPUT_LIMIT_BYTES
  );

  const exited = await Promise.race([
    child.exited,
    new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), INSTALL_TIMEOUT_MS)
    )
  ]);

  if (exited === 'timeout') {
    child.kill('SIGKILL');
    await Promise.allSettled([stderrPromise, stdoutPromise]);
    throw new Error(
      `Extension install timed out after ${INSTALL_TIMEOUT_MS}ms in ${cwd}`
    );
  }

  const [stderr, stdout] = await Promise.all([stderrPromise, stdoutPromise]);
  if (exited !== 0) {
    throw new Error(
      `Extension install failed (exit ${exited}) in ${cwd}: ${stderr || stdout}`
    );
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limitBytes: number
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total < limitBytes) {
      const remaining = limitBytes - total;
      const chunk =
        value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.length;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  const suffix = total === limitBytes ? '\n[output truncated]' : '';
  return `${new TextDecoder().decode(merged)}${suffix}`;
}
