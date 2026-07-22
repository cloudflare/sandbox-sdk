import { join } from 'node:path';
import {
  extractChangelogSection,
  publicDockerTags,
  type DockerTagMapping
} from './release-state.ts';
import {
  absolutePath,
  commitSHA,
  npmPackageName,
  sourceTag,
  stableVersion,
  versionTag,
  type AbsolutePath,
  type CommitSHA,
  type NpmPackageName,
  type SourceTag,
  type StableVersion,
  type VersionTag
} from './release-primitives.ts';

export type ReleaseMode = 'current' | 'historical';

export interface StableReleaseContext {
  readonly version: StableVersion;
  readonly releaseSHA: CommitSHA;
  readonly releaseRoot: AbsolutePath;
  readonly sourceTag: SourceTag;
  readonly versionTag: VersionTag;
  readonly dockerImages: readonly DockerTagMapping[];
  readonly npmPackageName: NpmPackageName;
  readonly mode: ReleaseMode;
  readonly changelogBody: string;
  readonly requiredAssets: readonly string[];
}

export interface StableReleaseContextInput {
  version: string;
  releaseSHA: string;
  releaseRoot: string;
  sourceTag: string;
  mode: ReleaseMode;
}

export interface StableReleaseContextDeps {
  readFile(path: string): string;
  commandText(
    command: string,
    args: readonly string[],
    options: { cwd: string }
  ): Promise<string>;
}

interface PackageManifest {
  name: string;
  version: string;
}

export async function createStableReleaseContext(
  input: StableReleaseContextInput,
  deps: StableReleaseContextDeps
): Promise<StableReleaseContext> {
  const version = stableVersion(input.version);
  const releaseSHA = commitSHA(input.releaseSHA);
  const releaseRoot = absolutePath(input.releaseRoot);
  const observed = (
    await deps.commandText('git', ['rev-parse', 'HEAD'], { cwd: releaseRoot })
  ).trim();
  if (observed !== releaseSHA) {
    throw new Error(
      `releaseRoot HEAD ${observed} does not match releaseSHA ${releaseSHA}`
    );
  }

  const manifest = JSON.parse(
    deps.readFile(join(releaseRoot, 'packages/sandbox/package.json'))
  ) as PackageManifest;
  const packageName = npmPackageName(manifest.name);
  if (manifest.version !== version) {
    throw new Error(
      `Release root package version ${manifest.version} does not match requested ${version}`
    );
  }

  const imageNames = parseDockerImages(
    deps.readFile(join(releaseRoot, 'docker-images.txt'))
  );
  const changelog = deps.readFile(
    join(releaseRoot, 'packages/sandbox/CHANGELOG.md')
  );

  return Object.freeze({
    version,
    releaseSHA,
    releaseRoot,
    sourceTag: sourceTag(input.sourceTag),
    versionTag: versionTag(`@cloudflare/sandbox@${version}`),
    dockerImages: publicDockerTags(
      version,
      imageNames,
      undefined,
      input.sourceTag
    ),
    npmPackageName: packageName,
    mode: input.mode,
    changelogBody: extractChangelogSection(changelog, version),
    requiredAssets: [
      'sandbox-linux-x64',
      'sandbox-linux-x64.sha256',
      'sandbox-linux-x64-musl',
      'sandbox-linux-x64-musl.sha256'
    ]
  });
}

export function parseDockerImages(content: string): string[] {
  const images = content
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  for (const image of images) {
    if (!/^sandbox(-[a-z0-9]+)*$/.test(image)) {
      throw new Error(`Invalid image name in docker-images.txt: ${image}`);
    }
  }
  if (images.length === 0) {
    throw new Error('No images found in docker-images.txt');
  }
  return images;
}
