import type { Decision } from './release-decisions.ts';
import type { StableInspection } from './release-inspect.ts';
import type { PreparedNpmPackage } from './npm-package-prep.ts';
import type { DockerRef } from './release-platform.ts';
import type {
  CommitSHA,
  StableVersion,
  VersionTag
} from './release-primitives.ts';
import { compareStableSemver } from './release-semver.ts';
import type { PreparedRelease } from './stable-release-preparation.ts';
import type { StableReleaseContext } from './stable-release-context.ts';

export type ReleaseOperation =
  | {
      type: 'publish-npm';
      prepared: PreparedNpmPackage;
      npmTag: string;
    }
  | { type: 'create-git-tag'; tag: VersionTag; sha: CommitSHA }
  | {
      type: 'create-github-release';
      tag: VersionTag;
      sha: CommitSHA;
      notes: string;
    }
  | {
      type: 'upload-github-asset';
      releaseTag: VersionTag;
      name: string;
      path: string;
    }
  | { type: 'copy-docker'; source: DockerRef; target: DockerRef };

export type LatestAction =
  | { type: 'set'; version: StableVersion }
  | { type: 'preserve'; version: StableVersion }
  | { type: 'none' };

export interface StableReleasePlan {
  operations: ReleaseOperation[];
  conflicts: string[];
  latestAction: LatestAction;
  summary: string;
}

export function planStableRelease(
  context: StableReleaseContext,
  inspection: StableInspection,
  prepared: PreparedRelease
): StableReleasePlan {
  const latestAction = decideLatest(context, inspection);
  const conflicts = collectConflicts(context, inspection);
  if (conflicts.length > 0) {
    return {
      operations: [],
      conflicts,
      latestAction,
      summary: conflicts.join('\n')
    };
  }

  // Tag first so identity recovery stays valid if later steps fail.
  // Publish current npm releases directly to latest only after every other
  // release artifact is complete.
  const operations: ReleaseOperation[] = [];
  if (inspection.git.versionTag.state === 'missing') {
    operations.push({
      type: 'create-git-tag',
      tag: context.versionTag,
      sha: context.releaseSHA
    });
  }
  if (inspection.github.release.state === 'missing') {
    operations.push({
      type: 'create-github-release',
      tag: context.versionTag,
      sha: context.releaseSHA,
      notes: context.changelogBody
    });
  }
  if (inspection.github.release.state !== 'conflict') {
    const requiredAssets = new Set(prepared.requiredAssets);
    for (const asset of inspection.github.assets) {
      if (
        asset.decision.state === 'missing' &&
        requiredAssets.has(asset.name)
      ) {
        operations.push({
          type: 'upload-github-asset',
          releaseTag: context.versionTag,
          name: asset.name,
          path: asset.path
        });
      }
    }
  }
  for (const target of inspection.docker.targets) {
    if (target.decision.state === 'missing') {
      operations.push({
        type: 'copy-docker',
        source: target.sourceRef,
        target: target.targetRef
      });
    }
  }
  if (inspection.npm.version.state === 'missing') {
    operations.push({
      type: 'publish-npm',
      prepared: prepared.npm,
      npmTag:
        context.mode === 'current' && latestAction.type === 'set'
          ? 'latest'
          : npmPublicationTag(context.version)
    });
  }

  return {
    operations,
    conflicts: [],
    latestAction,
    summary: `${operations.length} operation(s)`
  };
}

function collectConflicts(
  context: StableReleaseContext,
  inspection: StableInspection
): string[] {
  const conflicts: string[] = [];
  addConflict(conflicts, 'npm.version', inspection.npm.version);
  if (inspection.npm.latest.state === 'conflict') {
    conflicts.push(`npm.latest: ${inspection.npm.latest.conflict}`);
  } else if (inspection.npm.latest.state === 'matching') {
    const comparison = compareStableSemver(
      inspection.npm.latest.observed.version,
      context.version
    );
    if (context.mode === 'current' && comparison > 0) {
      conflicts.push(
        `npm.latest: current latest ${inspection.npm.latest.observed.version} is newer than requested ${context.version}`
      );
    }
  }
  if (
    context.mode === 'current' &&
    inspection.npm.version.state === 'matching' &&
    latestNeedsUpdate(context, inspection)
  ) {
    conflicts.push(
      `npm.latest: ${context.npmPackageName}@${context.version} is already published but latest does not point to it; run "npm dist-tag add ${context.npmPackageName}@${context.version} latest" with maintainer authentication, then retry`
    );
  }
  addConflict(conflicts, 'git.versionTag', inspection.git.versionTag);
  addConflict(conflicts, 'github.release', inspection.github.release);
  for (const asset of inspection.github.assets) {
    addConflict(conflicts, `github.asset.${asset.name}`, asset.decision);
  }
  for (const target of inspection.docker.targets) {
    addConflict(conflicts, renderDockerRef(target.targetRef), target.decision);
  }
  return conflicts;
}

function decideLatest(
  context: StableReleaseContext,
  inspection: StableInspection
): LatestAction {
  if (context.mode === 'historical') {
    if (inspection.npm.latest.state === 'matching') {
      return {
        type: 'preserve',
        version: inspection.npm.latest.observed.version
      };
    }
    return { type: 'none' };
  }
  if (inspection.npm.latest.state === 'missing') {
    return { type: 'set', version: context.version };
  }
  if (inspection.npm.latest.state === 'conflict') {
    return { type: 'none' };
  }

  const observed = inspection.npm.latest.observed.version;
  const comparison = compareStableSemver(observed, context.version);
  if (comparison < 0) return { type: 'set', version: context.version };
  if (comparison === 0) return { type: 'none' };
  return { type: 'preserve', version: observed };
}

function latestNeedsUpdate(
  context: StableReleaseContext,
  inspection: StableInspection
): boolean {
  if (inspection.npm.latest.state === 'missing') return true;
  if (inspection.npm.latest.state === 'conflict') return false;
  return (
    compareStableSemver(
      inspection.npm.latest.observed.version,
      context.version
    ) < 0
  );
}

function addConflict(
  conflicts: string[],
  name: string,
  decision: Decision<unknown, string>
): void {
  if (decision.state === 'conflict') {
    conflicts.push(`${name}: ${decision.conflict}`);
  }
}

function renderDockerRef(ref: DockerRef): string {
  return `${ref.repository}:${ref.tag}`;
}

function npmPublicationTag(version: StableVersion): string {
  return `release-${version.replaceAll('.', '-')}`;
}
