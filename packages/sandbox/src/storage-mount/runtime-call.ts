import type { ContainerControlClient } from '../container-control';

export type MountRuntimeCall = <T>(
  operation: string,
  call: (control: ContainerControlClient) => Promise<T>
) => Promise<T>;
