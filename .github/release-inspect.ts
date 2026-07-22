import type { Decision } from './release-decisions.ts';
import { OperationalReleaseError } from './release-errors.ts';
import type {
  DockerRef,
  GitHubReleaseInfo,
  ReleasePlatform
} from './release-platform.ts';
import type { ImageDigest, StableVersion } from './release-primitives.ts';
import type { PreparedRelease } from './stable-release-preparation.ts';
import type { StableReleaseContext } from './stable-release-context.ts';

export interface DockerTargetInspection {
  sourceRef: DockerRef;
  targetRef: DockerRef;
  expectedDigest?: ImageDigest;
  decision: Decision<{ digest: ImageDigest }, string>;
}

export interface GitHubAssetInspection {
  name: string;
  path: string;
  decision: Decision<{ name: string }, string>;
}

export interface StableInspection {
  npm: {
    version: Decision<{ version: StableVersion }, string>;
    latest: Decision<{ version: StableVersion }, string>;
  };
  git: {
    versionTag: Decision<{ sha: string }, string>;
  };
  github: {
    release: Decision<{ tagName: string }, string>;
    assets: readonly GitHubAssetInspection[];
  };
  docker: {
    targets: readonly DockerTargetInspection[];
  };
}

export async function inspectStableRelease(
  context: StableReleaseContext,
  prepared: PreparedRelease,
  platform: ReleasePlatform
): Promise<StableInspection> {
  const [npmVersion, npmLatest, gitTag, githubRelease, dockerTargets] =
    await Promise.all([
      inspectDomain('npm', () =>
        platform.npm.inspectVersion(context.npmPackageName, context.version)
      ),
      inspectDomain('npm', () =>
        platform.npm.inspectDistTag(context.npmPackageName, 'latest')
      ),
      inspectDomain('git', () => platform.git.resolveTag(context.versionTag)),
      inspectDomain('github', () =>
        platform.github.inspectRelease(context.versionTag)
      ),
      inspectDomain('docker', () => inspectDockerTargets(context, platform))
    ]);

  return {
    npm: {
      version:
        npmVersion === undefined
          ? { state: 'missing' }
          : { state: 'matching', observed: { version: npmVersion.version } },
      latest:
        npmLatest === undefined
          ? { state: 'missing' }
          : { state: 'matching', observed: { version: npmLatest } }
    },
    git: {
      versionTag:
        gitTag === undefined
          ? { state: 'missing' }
          : gitTag === context.releaseSHA
            ? { state: 'matching', observed: { sha: gitTag } }
            : {
                state: 'conflict',
                conflict: `tag ${context.versionTag} points to ${gitTag}, expected ${context.releaseSHA}`
              }
    },
    github: {
      release: decideGitHubRelease(context, githubRelease),
      assets: decideGitHubAssets(prepared.assets, githubRelease)
    },
    docker: { targets: dockerTargets }
  };
}

async function inspectDomain<T>(
  domain: string,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new OperationalReleaseError(
      'inspect',
      domain,
      error instanceof Error ? error.message : String(error),
      error
    );
  }
}

function decideGitHubRelease(
  context: StableReleaseContext,
  release: GitHubReleaseInfo | undefined
): Decision<{ tagName: string }, string> {
  if (release === undefined) return { state: 'missing' };
  if (release.tagName !== context.versionTag) {
    return {
      state: 'conflict',
      conflict: `GitHub Release uses tag ${release.tagName}, expected ${context.versionTag}`
    };
  }
  return { state: 'matching', observed: { tagName: release.tagName } };
}

function decideGitHubAssets(
  assets: readonly { name: string; path: string }[],
  release: GitHubReleaseInfo | undefined
): GitHubAssetInspection[] {
  return assets.map((asset) => ({
    name: asset.name,
    path: asset.path,
    decision: release?.assets.includes(asset.name)
      ? { state: 'matching', observed: { name: asset.name } }
      : { state: 'missing' }
  }));
}

async function inspectDockerTargets(
  context: StableReleaseContext,
  platform: ReleasePlatform
): Promise<DockerTargetInspection[]> {
  const sourceDigests = new Map<string, Promise<ImageDigest | undefined>>();
  const targets = context.dockerImages.flatMap((mapping) => {
    const sourceRef = parseDockerRef(mapping.sourceRef);
    return [mapping.dockerHubRef, mapping.cfLibraryRef].map((target) => ({
      sourceRef,
      targetRef: parseDockerRef(target)
    }));
  });

  return Promise.all(
    targets.map(async ({ sourceRef, targetRef }) => {
      const sourceKey = renderDockerRef(sourceRef);
      let sourceDigest = sourceDigests.get(sourceKey);
      if (sourceDigest === undefined) {
        sourceDigest = platform.docker.resolveDigest(sourceRef);
        sourceDigests.set(sourceKey, sourceDigest);
      }
      const [expectedDigest, targetDigest] = await Promise.all([
        sourceDigest,
        platform.docker.resolveDigest(targetRef)
      ]);
      return {
        sourceRef,
        targetRef,
        expectedDigest,
        decision: decideDockerTarget(
          sourceRef,
          targetRef,
          expectedDigest,
          targetDigest
        )
      };
    })
  );
}

function decideDockerTarget(
  sourceRef: DockerRef,
  targetRef: DockerRef,
  expectedDigest: ImageDigest | undefined,
  targetDigest: ImageDigest | undefined
): Decision<{ digest: ImageDigest }, string> {
  if (expectedDigest === undefined) {
    return {
      state: 'conflict',
      conflict: `source image ${renderDockerRef(sourceRef)} is missing`
    };
  }
  if (targetDigest === undefined) return { state: 'missing' };
  if (targetDigest === expectedDigest) {
    return { state: 'matching', observed: { digest: targetDigest } };
  }
  return {
    state: 'conflict',
    conflict: `target image ${renderDockerRef(targetRef)} has digest ${targetDigest}, expected ${expectedDigest}`
  };
}

function parseDockerRef(value: string): DockerRef {
  const separator = value.lastIndexOf(':');
  const slash = value.lastIndexOf('/');
  if (separator <= slash || separator === value.length - 1) {
    throw new Error(`Docker ref must include a tag: ${value}`);
  }
  return {
    repository: value.slice(0, separator),
    tag: value.slice(separator + 1)
  };
}

function renderDockerRef(ref: DockerRef): string {
  return `${ref.repository}:${ref.tag}`;
}
