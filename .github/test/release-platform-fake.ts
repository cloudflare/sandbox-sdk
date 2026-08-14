import type { PreparedNpmPackage } from '../npm-package-prep.ts';
import type {
  DockerRef,
  GitHubReleaseInfo,
  NpmVersionInfo,
  ReleasePlatform
} from '../release-platform.ts';
import {
  stableVersion,
  type CommitSHA,
  type ImageDigest,
  type StableVersion,
  type VersionTag
} from '../release-primitives.ts';

function refKey(ref: DockerRef): string {
  return `${ref.repository}:${ref.tag}`;
}

export class FakeReleasePlatform implements ReleasePlatform {
  readonly operations: string[] = [];
  readonly npmVersions = new Map<string, NpmVersionInfo>();
  readonly distTags = new Map<string, StableVersion>();
  readonly gitTags = new Map<string, CommitSHA>();
  readonly releases = new Map<string, GitHubReleaseInfo>();
  readonly digests = new Map<string, ImageDigest>();
  readonly npm = {
    inspectVersion: async (name: string, version: StableVersion) =>
      this.npmVersions.get(`${name}@${version}`),
    inspectDistTag: async (name: string, tag: 'latest') =>
      this.distTags.get(`${name}:${tag}`),
    publishPreparedPackage: async (
      prepared: PreparedNpmPackage,
      tag: string
    ) => {
      this.operations.push(`npm.publish ${prepared.tarballPath} ${tag}`);
      this.npmVersions.set(`${prepared.packageName}@${prepared.version}`, {
        version: stableVersion(prepared.version)
      });
      if (tag === 'latest') {
        this.distTags.set(
          `${prepared.packageName}:latest`,
          stableVersion(prepared.version)
        );
      }
    }
  };
  readonly git = {
    resolveTag: async (tag: VersionTag) => this.gitTags.get(tag),
    createTag: async (tag: VersionTag, sha: CommitSHA) => {
      this.operations.push(`git.createTag ${tag} ${sha}`);
      this.gitTags.set(tag, sha);
    }
  };
  readonly github = {
    inspectRelease: async (name: VersionTag) => this.releases.get(name),
    createRelease: async (name: VersionTag, sha: CommitSHA, notes: string) => {
      this.operations.push(
        `github.createRelease ${name} ${sha} ${notes.length}`
      );
      this.releases.set(name, { tagName: name, assets: [] });
    },
    uploadAsset: async (name: VersionTag, path: string) => {
      this.operations.push(`github.uploadAsset ${name} ${path}`);
      const current = this.releases.get(name) ?? {
        tagName: name,
        assets: []
      };
      this.releases.set(name, {
        tagName: current.tagName,
        assets: [...current.assets, path.split('/').pop() ?? path].sort()
      });
    }
  };
  readonly docker = this.createDockerClient();

  private createDockerClient() {
    return {
      resolveDigest: async (ref: DockerRef) => this.digests.get(refKey(ref)),
      copyImage: async (source: DockerRef, target: DockerRef) => {
        const digest = this.digests.get(refKey(source));
        if (digest === undefined) {
          throw new Error(`source image missing: ${refKey(source)}`);
        }
        this.operations.push(`docker.copy ${refKey(source)} ${refKey(target)}`);
        this.digests.set(refKey(target), digest);
      }
    };
  }
}
