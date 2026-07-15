import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ReleaseMode = 'stable' | 'prerelease';

export interface DockerTagMapping {
  image: string;
  sourceTag: string;
  tag: string;
  aliasTag?: string;
  dockerHubRef: string;
  cfLibraryRef: string;
  sourceRef: string;
}

export interface StableReleaseState {
  mode: 'stable';
  npmPackage: '@cloudflare/sandbox';
  version: string;
  sourceTag: string;
  commitSha: string;
  npmTag: 'latest';
  gitTag: string;
  githubReleaseName: string;
  changelogBody: string;
  dockerTags: DockerTagMapping[];
  releaseAssets: string[];
}

export interface PrereleaseReleaseState {
  mode: 'prerelease';
  npmPackage: '@cloudflare/sandbox';
  version: string;
  sourceTag: string;
  npmTag: string;
  dockerAlias?: string;
  dockerTags: DockerTagMapping[];
}

function validateImageName(image: string, source: string): void {
  if (!/^sandbox(-[a-z0-9]+)*$/.test(image)) {
    throw new Error(`Invalid image name${source}: ${image}`);
  }
}

export function loadDockerImages(root: string): string[] {
  const content = readFileSync(join(root, 'docker-images.txt'), 'utf8');
  const images = content
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  for (const image of images) {
    validateImageName(image, ' in docker-images.txt');
  }

  if (images.length === 0) {
    throw new Error('No images found in docker-images.txt');
  }

  return images;
}

export function publicDockerTags(
  version: string,
  images: string[],
  alias?: string,
  sourceTag = ''
): DockerTagMapping[] {
  for (const image of images) {
    validateImageName(image, '');
  }

  return images
    .filter((image) => image !== 'sandbox-standalone')
    .map((image) => {
      const suffix = image.slice('sandbox'.length);
      const tag = `${version}${suffix}`;
      const aliasTag = alias ? `${alias}${suffix}` : undefined;

      return {
        image,
        sourceTag,
        tag,
        aliasTag,
        dockerHubRef: `docker.io/cloudflare/sandbox:${tag}`,
        cfLibraryRef: `registry.cloudflare.com/library/sandbox:${tag}`,
        sourceRef: sourceTag
          ? `registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/${image}:${sourceTag}`
          : ''
      };
    });
}

export function extractChangelogSection(
  changelog: string,
  version: string
): string {
  const headingPattern = new RegExp(
    `(^|\\n)## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s*(?:\\n|$))`
  );
  const match = headingPattern.exec(changelog);

  if (match === null) {
    throw new Error(`Could not find changelog section for ${version}`);
  }

  const start = match.index + match[1].length;
  const bodyStart = start + match[0].length - match[1].length;
  const nextHeader = changelog.indexOf('\n## ', bodyStart);
  const raw =
    nextHeader === -1
      ? changelog.slice(bodyStart)
      : changelog.slice(bodyStart, nextHeader);
  const body = raw.trim();

  if (body.length === 0) {
    throw new Error(`Changelog section for ${version} is empty`);
  }

  return body;
}

export function stableReleaseState(options: {
  version: string;
  sourceTag: string;
  commitSha: string;
  images: string[];
  changelogBody: string;
}): StableReleaseState {
  return {
    mode: 'stable',
    npmPackage: '@cloudflare/sandbox',
    version: options.version,
    sourceTag: options.sourceTag,
    commitSha: options.commitSha,
    npmTag: 'latest',
    gitTag: `@cloudflare/sandbox@${options.version}`,
    githubReleaseName: `@cloudflare/sandbox@${options.version}`,
    changelogBody: options.changelogBody,
    dockerTags: publicDockerTags(
      options.version,
      options.images,
      undefined,
      options.sourceTag
    ),
    releaseAssets: [
      'sandbox-linux-x64',
      'sandbox-linux-x64.sha256',
      'sandbox-linux-x64-musl',
      'sandbox-linux-x64-musl.sha256'
    ]
  };
}

export function prereleaseReleaseState(options: {
  version: string;
  sourceTag: string;
  npmTag: string;
  dockerAlias?: string;
  images: string[];
}): PrereleaseReleaseState {
  return {
    mode: 'prerelease',
    npmPackage: '@cloudflare/sandbox',
    version: options.version,
    sourceTag: options.sourceTag,
    npmTag: options.npmTag,
    dockerAlias: options.dockerAlias,
    dockerTags: publicDockerTags(
      options.version,
      options.images,
      options.dockerAlias,
      options.sourceTag
    )
  };
}
