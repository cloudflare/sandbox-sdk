import type { MountInfo } from './types';

export class MountRegistry {
  private readonly mounts = new Map<string, MountInfo>();

  get activeMounts(): Map<string, MountInfo> {
    return this.mounts;
  }

  has(mountPath: string): boolean {
    return this.mounts.has(mountPath);
  }

  get(mountPath: string): MountInfo | undefined {
    return this.mounts.get(mountPath);
  }

  set(mountPath: string, mountInfo: MountInfo): void {
    this.mounts.set(mountPath, mountInfo);
  }

  delete(mountPath: string): void {
    this.mounts.delete(mountPath);
  }

  clear(): void {
    this.mounts.clear();
  }

  entries(): IterableIterator<[string, MountInfo]> {
    return this.mounts.entries();
  }

  [Symbol.iterator](): IterableIterator<[string, MountInfo]> {
    return this.mounts.entries();
  }
}
