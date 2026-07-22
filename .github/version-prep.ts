const SDK_VERSION_PATTERN = /export const SDK_VERSION = '[^']*';/;

export function updateSdkVersionSource(
  source: string,
  version: string
): string {
  if (!SDK_VERSION_PATTERN.test(source)) {
    throw new Error('SDK_VERSION constant not found in version source');
  }

  return source.replace(
    SDK_VERSION_PATTERN,
    `export const SDK_VERSION = '${version}';`
  );
}
