const ATOMIC_WRITE_TEMP_SUFFIX =
  /^(.*)\.tmp\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function createAtomicWriteTempPath(targetPath: string): string {
  return `${targetPath}.tmp.${crypto.randomUUID()}`;
}

export function getAtomicWriteTargetPath(tempPath: string): string | null {
  return ATOMIC_WRITE_TEMP_SUFFIX.exec(tempPath)?.[1] ?? null;
}
