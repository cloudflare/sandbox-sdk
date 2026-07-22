import type { ContainerControlClient } from '../container-control';
import type { RuntimeIdentity } from '../runtime';

export type MountRuntimeHold = { release(): void };

export type MountRuntimeLease = {
  runtime: RuntimeIdentity;
  control: ContainerControlClient;
  retain(onInterrupt?: () => void): MountRuntimeHold;
};

export type MountRuntimeCall = <T>(
  operation: string,
  call: (control: ContainerControlClient) => Promise<T>
) => Promise<T>;

export type MountRuntimeAttempt = <T>(
  operation: string,
  call: (lease: MountRuntimeLease) => Promise<T>
) => Promise<T>;

export type MountExistingRuntimeAttempt = <T>(
  operation: string,
  call: (lease: MountRuntimeLease) => Promise<T>
) => Promise<{ status: 'absent' } | { status: 'completed'; value: T }>;

export function callWithMountControl(
  control: ContainerControlClient
): MountRuntimeCall {
  return async (_operation, call) => await call(control);
}
