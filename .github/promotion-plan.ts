export interface PromotionFile {
  path: string;
  content: string;
}

export interface PromotionEdit {
  path: string;
  content: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
// Matches the public sandbox image only (not sandbox-test): an optional
// docker.io/ prefix, then cloudflare/sandbox:, then the tag up to the next
// whitespace or quote.
const SANDBOX_REF = /(docker\.io\/)?cloudflare\/sandbox:([^\s"'`]+)/g;
const SANDBOX_TAG = /^(\d+\.\d+\.\d+)(-[a-z0-9]+)?$/;

export function computePromotionEdits(
  files: PromotionFile[],
  targetVersion: string
): PromotionEdit[] {
  if (!SEMVER.test(targetVersion)) {
    throw new Error(`Malformed target version: ${targetVersion}`);
  }

  const sourceVersions = new Set<string>();

  for (const file of files) {
    for (const match of file.content.matchAll(SANDBOX_REF)) {
      const tag = match[2];
      const tagMatch = SANDBOX_TAG.exec(tag);
      if (tagMatch === null) {
        throw new Error(
          `Malformed sandbox image reference: cloudflare/sandbox:${tag}`
        );
      }
      if (tagMatch[1] !== targetVersion) {
        sourceVersions.add(tagMatch[1]);
      }
    }
  }

  if (sourceVersions.size > 1) {
    throw new Error(
      `Mixed sandbox image versions: ${[...sourceVersions].sort().join(', ')}`
    );
  }

  const edits: PromotionEdit[] = [];
  for (const file of files) {
    const content = file.content.replace(
      SANDBOX_REF,
      (_full, prefix: string | undefined, tag: string) => {
        const suffix = SANDBOX_TAG.exec(tag)?.[2] ?? '';
        return `${prefix ?? ''}cloudflare/sandbox:${targetVersion}${suffix}`;
      }
    );
    if (content !== file.content) {
      edits.push({ path: file.path, content });
    }
  }

  return edits;
}
