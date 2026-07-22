import type { StableVersion } from './release-primitives.ts';

export interface StableSemver {
  major: number;
  minor: number;
  patch: number;
}

function parseStableSemverPart(value: string): number {
  const part = Number(value);
  if (!Number.isSafeInteger(part)) {
    throw new Error(
      `Stable version component must be a safe integer: ${value}`
    );
  }
  return part;
}

export function parseStableSemver(version: StableVersion): StableSemver {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) {
    throw new Error(`Stable version must be MAJOR.MINOR.PATCH: ${version}`);
  }
  return {
    major: parseStableSemverPart(match[1]),
    minor: parseStableSemverPart(match[2]),
    patch: parseStableSemverPart(match[3])
  };
}

export function compareStableSemver(
  left: StableVersion,
  right: StableVersion
): -1 | 0 | 1 {
  const a = parseStableSemver(left);
  const b = parseStableSemver(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}
