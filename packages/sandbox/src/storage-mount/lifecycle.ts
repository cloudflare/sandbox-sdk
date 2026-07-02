import type {
  CurrentRuntimeIdentity,
  RuntimeIdentity
} from '../current-runtime-identity';
import type {
  CurrentSandboxLifetime,
  SandboxLifetime
} from '../sandbox-lifetime';

export type MountLifecycleSnapshot = {
  runtime: RuntimeIdentity | null;
  lifetime: SandboxLifetime;
};

export class MountLifecycle {
  constructor(
    private readonly currentRuntime: CurrentRuntimeIdentity,
    private readonly currentLifetime: CurrentSandboxLifetime
  ) {}

  async capture(): Promise<MountLifecycleSnapshot> {
    return {
      runtime: await this.currentRuntime.get(),
      lifetime: await this.currentLifetime.getOrCreate()
    };
  }

  async assertCurrent(snapshot: MountLifecycleSnapshot): Promise<void> {
    if (snapshot.runtime) {
      await this.currentRuntime.assertActive(snapshot.runtime);
    }
    await this.currentLifetime.assertCurrent(snapshot.lifetime);
  }
}
