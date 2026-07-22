import type { PreparedRelease } from '../stable-release-preparation.ts';
import {
  absolutePath,
  commitSHA,
  npmPackageName,
  sourceTag,
  stableVersion,
  versionTag
} from '../release-primitives.ts';
import type { StableReleaseContext } from '../stable-release-context.ts';

export function makeContext(): StableReleaseContext {
  const version = stableVersion('1.2.3');
  return Object.freeze({
    version,
    releaseSHA: commitSHA('0123456789abcdef0123456789abcdef01234567'),
    releaseRoot: absolutePath('/tmp/release-root'),
    sourceTag: sourceTag('ci-abc'),
    versionTag: versionTag('@cloudflare/sandbox@1.2.3'),
    dockerImages: [
      {
        image: 'sandbox',
        sourceTag: 'ci-abc',
        tag: '1.2.3',
        dockerHubRef: 'docker.io/cloudflare/sandbox:1.2.3',
        cfLibraryRef: 'registry.cloudflare.com/library/sandbox:1.2.3',
        sourceRef: 'registry.cloudflare.com/cf-account/sandbox:ci-abc'
      }
    ],
    npmPackageName: npmPackageName('@cloudflare/sandbox'),
    mode: 'current',
    changelogBody: '- Fixed release',
    requiredAssets: ['sandbox-linux-x64', 'sandbox-linux-x64.sha256']
  });
}

export function makePreparedRelease(): PreparedRelease {
  return {
    npm: {
      packageName: '@cloudflare/sandbox',
      version: '1.2.3',
      packageDir: '/tmp/pkg',
      tarballPath: '/tmp/pkg/pkg.tgz',
      cleanup: async () => undefined
    },
    assets: [
      {
        name: 'sandbox-linux-x64',
        path: '/tmp/assets/sandbox-linux-x64'
      },
      {
        name: 'sandbox-linux-x64.sha256',
        path: '/tmp/assets/sandbox-linux-x64.sha256'
      }
    ],
    requiredAssets: ['sandbox-linux-x64', 'sandbox-linux-x64.sha256'],
    cleanup: async () => undefined
  };
}
