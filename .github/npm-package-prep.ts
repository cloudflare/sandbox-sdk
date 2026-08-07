import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PreparedNpmPackage {
  packageName: '@cloudflare/sandbox';
  version: string;
  packageDir: string;
  tarballPath: string;
  cleanup(): Promise<void>;
}

export interface NpmPrepInput {
  releaseRoot: string;
  packageName: '@cloudflare/sandbox';
  version: string;
  versionOverride?: string;
}

export interface NpmPrepDeps {
  makeTempDir(prefix: string): string;
  copyPackage(from: string, to: string): void;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  command(
    command: string,
    args: readonly string[],
    options: { cwd: string }
  ): Promise<ProcessResult>;
  remove(path: string): Promise<void>;
  workspaceVersions(releaseRoot: string): Map<string, string>;
}

interface Manifest {
  name: string;
  version: string;
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackResult {
  filename: string;
  files: { path: string }[];
}

export async function prepareNpmPackage(
  input: NpmPrepInput,
  deps: NpmPrepDeps = nodeNpmPrepDeps
): Promise<PreparedNpmPackage> {
  const tempRoot = deps.makeTempDir('sandbox-npm-');
  const packageDir = join(tempRoot, 'package');
  let cleaned = false;
  const cleanup = async () => {
    if (!cleaned) {
      await deps.remove(tempRoot);
      cleaned = true;
    }
  };

  try {
    deps.copyPackage(
      join(input.releaseRoot, 'packages', 'sandbox'),
      packageDir
    );
    const manifestPath = join(packageDir, 'package.json');
    const manifest = JSON.parse(deps.readFile(manifestPath)) as Manifest;
    validateManifest(manifest, input.packageName, input.version);
    if (input.versionOverride !== undefined) {
      manifest.version = input.versionOverride;
    }
    const workspaceVersions = deps.workspaceVersions(input.releaseRoot);
    rewriteWorkspaceRanges(manifest, workspaceVersions);
    rejectWorkspaceRanges(manifest, workspaceVersions);
    deps.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const exportedFiles = exportedManifestFiles(manifest);
    validateExportFiles(exportedFiles, packageDir, deps.exists);
    const pack = await npmPack(packageDir, deps);
    validatePackFiles(pack, exportedFiles);

    return {
      packageName: input.packageName,
      version: manifest.version,
      packageDir,
      tarballPath: join(packageDir, pack.filename),
      cleanup
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        error instanceof Error
          ? error.message
          : 'npm package preparation failed and cleanup also failed'
      );
    }
    throw error;
  }
}

function validateManifest(
  manifest: Manifest,
  packageName: '@cloudflare/sandbox',
  version: string
): void {
  if (manifest.name !== packageName) {
    throw new Error(
      `Staged package name ${manifest.name} is not ${packageName}`
    );
  }
  if (manifest.version !== version) {
    throw new Error(
      `Staged package version ${manifest.version} does not match requested ${version}`
    );
  }
}

function rewriteWorkspaceRanges(
  manifest: Manifest,
  versions: Map<string, string>
): void {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ] as const) {
    const dependencies = manifest[field];
    if (dependencies === undefined) {
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      const version = versions.get(name);
      if (
        version !== undefined &&
        (range === '*' || range.startsWith('workspace:'))
      ) {
        dependencies[name] = version.startsWith('0.0.0-')
          ? version
          : `^${version}`;
      }
    }
  }
}

function rejectWorkspaceRanges(
  manifest: Manifest,
  versions: Map<string, string>
): void {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ] as const) {
    const dependencies = manifest[field];
    if (dependencies === undefined) {
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (
        versions.has(name) &&
        (range === '*' || range.startsWith('workspace:'))
      ) {
        throw new Error(
          `Staged manifest keeps unresolved workspace range for ${name}: ${range}`
        );
      }
    }
  }
}

function exportedManifestFiles(manifest: Manifest): string[] {
  const files = new Set<string>();
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') {
      files.add(value.replace(/^\.\//, ''));
    } else {
      for (const nested of Object.values(value)) {
        files.add(nested.replace(/^\.\//, ''));
      }
    }
  }
  return [...files].sort();
}

function validateExportFiles(
  files: readonly string[],
  packageDir: string,
  exists: (path: string) => boolean
): void {
  for (const file of files) {
    if (!exists(join(packageDir, file))) {
      throw new Error(
        `Declared export file is missing from staged package: ${file}`
      );
    }
  }
}

async function npmPack(
  packageDir: string,
  deps: NpmPrepDeps
): Promise<PackResult> {
  const result = await deps.command('npm', ['pack', '--json'], {
    cwd: packageDir
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `npm pack failed: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  const pack = parseNpmPackResult(result.stdout);
  if (pack.filename.trim() === '') {
    throw new Error(`npm pack produced no tarball: ${result.stdout.trim()}`);
  }
  return pack;
}

export function parseNpmPackResult(stdout: string): PackResult {
  const jsonText = extractJsonPayload(stdout);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(
      `npm pack produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const candidate = unwrapNpmPackCandidate(parsed);
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !('filename' in candidate) ||
    typeof (candidate as { filename: unknown }).filename !== 'string' ||
    !('files' in candidate) ||
    !Array.isArray((candidate as { files: unknown }).files)
  ) {
    throw new Error(`npm pack produced no tarball: ${stdout.trim()}`);
  }

  const files = (candidate as { files: unknown[] }).files.map((file) => {
    if (
      file === null ||
      typeof file !== 'object' ||
      !('path' in file) ||
      typeof (file as { path: unknown }).path !== 'string'
    ) {
      throw new Error(
        `npm pack produced malformed file list: ${stdout.trim()}`
      );
    }
    return { path: (file as { path: string }).path };
  });

  return {
    filename: (candidate as { filename: string }).filename,
    files
  };
}

function unwrapNpmPackCandidate(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    return parsed[0];
  }
  if (parsed === null || typeof parsed !== 'object') {
    return parsed;
  }
  if ('filename' in parsed) {
    return parsed;
  }
  const values = Object.values(parsed as Record<string, unknown>);
  if (values.length === 1) {
    return values[0];
  }
  return parsed;
}

function extractJsonPayload(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new Error('npm pack produced empty output');
  }
  const arrayStart = trimmed.indexOf('[');
  const objectStart = trimmed.indexOf('{');
  let start = -1;
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
    start = arrayStart;
  } else if (objectStart >= 0) {
    start = objectStart;
  }
  if (start < 0) {
    throw new Error(`npm pack produced no JSON payload: ${trimmed}`);
  }
  return trimmed.slice(start);
}

function validatePackFiles(
  pack: PackResult,
  exportedFiles: readonly string[]
): void {
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of ['package.json', ...exportedFiles]) {
    if (!paths.has(required)) {
      throw new Error(`npm pack output is missing ${required}`);
    }
  }
  for (const path of paths) {
    if (path.startsWith('../') || path.startsWith('/')) {
      throw new Error(`npm pack output escapes package boundary: ${path}`);
    }
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string }
): ProcessResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8'
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function readWorkspaceVersions(releaseRoot: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const relativePath of [
    'packages/sandbox/package.json',
    'packages/shared/package.json'
  ]) {
    const manifestPath = join(releaseRoot, relativePath);
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      version: string;
    };
    versions.set(manifest.name, manifest.version);
  }
  return versions;
}

export const nodeNpmPrepDeps: NpmPrepDeps = {
  makeTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  copyPackage: (from, to) => cpSync(from, to, { recursive: true }),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => writeFileSync(path, content),
  exists: existsSync,
  command: async (command, args, options) => runProcess(command, args, options),
  remove: async (path) => rmSync(path, { recursive: true, force: true }),
  workspaceVersions: readWorkspaceVersions
};
