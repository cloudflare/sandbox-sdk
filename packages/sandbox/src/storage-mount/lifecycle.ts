import type { RuntimeIdentity, RuntimeIdentityReader } from '../runtime';
import type {
  CurrentSandboxLifetime,
  SandboxLifetime
} from '../sandbox-lifetime';

export type MountLifecycleSnapshot = {
  runtime: RuntimeIdentity;
  lifetime: SandboxLifetime;
};

export class MountLifecycle {
  constructor(
    private readonly runtimeReader: RuntimeIdentityReader,
    private readonly currentLifetime: CurrentSandboxLifetime
  ) {}

  async capture(runtime: RuntimeIdentity): Promise<MountLifecycleSnapshot> {
    return {
      runtime,
      lifetime: await this.currentLifetime.getOrCreate()
    };
  }

  async assertCurrent(snapshot: MountLifecycleSnapshot): Promise<void> {
    await this.currentLifetime.assertCurrent(snapshot.lifetime);
    await this.runtimeReader.assertActive(snapshot.runtime);
  }
}
