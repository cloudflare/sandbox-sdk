/**
 * WarmPool — Durable Object that maintains a pool of pre-started sandbox containers.
 *
 * Adapted from https://github.com/mikenomitch/cf-container-warm-pool
 * Inlined and tailored for the @cloudflare/sandbox SDK.
 *
 * The pool keeps N idle containers standing by so new sandbox sessions boot
 * instantly.  Once a container is assigned to a sandbox ID it is consumed and
 * never returned to the pool.
 *
 * Configuration is pushed in via `configure()` on every request (idempotent)
 * so changes to wrangler vars take effect without manual intervention.
 */

import { DurableObject } from 'cloudflare:workers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WarmPoolConfig {
  /** Target number of warm (unassigned) containers to maintain. @default 0 */
  warmTarget?: number;
  /** How often to check and replenish warm containers (ms). @default 10000 */
  refreshInterval?: number;
}

export interface PoolStats {
  /** Number of warm (unassigned) containers ready for use */
  warm: number;
  /** Number of containers assigned to sandbox IDs */
  assigned: number;
  /** Total containers tracked by the pool */
  total: number;
  /** Current pool configuration */
  config: Required<WarmPoolConfig>;
  /** Inferred max_instances limit, or null if not yet known */
  maxInstances: number | null;
}

// ---------------------------------------------------------------------------
// Container RPC shapes (inherited by Sandbox from Container)
// ---------------------------------------------------------------------------

interface ContainerRpc {
  startAndWaitForPorts(): Promise<void>;
  stop(signal?: string): Promise<void>;
  renewActivityTimeout(): void;
}

interface ContainerState {
  lastChange: number;
  status: 'running' | 'stopping' | 'stopped' | 'healthy' | 'stopped_with_code';
  exitCode?: number;
}

interface ContainerWithState {
  getState(): Promise<ContainerState>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<WarmPoolConfig> = {
  warmTarget: 0,
  refreshInterval: 10_000
};

// ---------------------------------------------------------------------------
// WarmPool Durable Object
// ---------------------------------------------------------------------------

/**
 * The WarmPool expects an environment with a `Sandbox` Durable Object binding.
 * This interface describes the minimum shape; the actual binding name is
 * configurable via the bridge, but defaults to "Sandbox".
 */
interface WarmPoolEnv {
  Sandbox: DurableObjectNamespace;
  [key: string]: unknown;
}

export class WarmPool extends DurableObject<WarmPoolEnv> {
  private config: Required<WarmPoolConfig> = { ...DEFAULT_CONFIG };

  /** Container UUIDs that are warm and available for assignment */
  private warmContainers: Set<string> = new Set();

  /** Maps caller-provided sandbox IDs to container UUIDs (1:1, no sharing) */
  private assignments: Map<string, string> = new Map();

  /** Containers currently starting — excluded from health checks */
  private startingContainers: Set<string> = new Set();

  /** Inferred max_instances limit learned from Cloudflare errors, or null */
  private knownMaxInstances: number | null = null;

  private capacityExhausted = false;
  private initialized = false;

  // =======================================================================
  // Public RPC methods
  // =======================================================================

  /**
   * Get a container UUID for the given sandbox ID.
   * - If this ID already has an assigned container that's still running, return it.
   * - Otherwise assign a warm container (or start a new one).
   */
  async getContainer(sandboxId: string): Promise<string> {
    await this.init();

    const existing = this.assignments.get(sandboxId);
    if (existing) {
      const running = await this.isContainerRunning(existing);
      if (running) return existing;
      this.assignments.delete(sandboxId);
      await this.persist();
    }

    // Try to pop a warm container
    if (this.warmContainers.size > 0) {
      const containerUUID = this.warmContainers.values().next().value as string;
      this.warmContainers.delete(containerUUID);
      this.assignments.set(sandboxId, containerUUID);
      await this.persist();
      return containerUUID;
    }

    // Check capacity before starting on-demand
    if (this.remainingCapacity() <= 0) {
      this.throwCapacityError();
    }

    // Start one on-demand
    const containerUUID = await this.startContainer();
    if (containerUUID) {
      this.assignments.set(sandboxId, containerUUID);
      await this.persist();
      return containerUUID;
    }

    if (this.capacityExhausted) {
      this.throwCapacityError();
    }

    throw new Error('Failed to start container');
  }

  /**
   * Look up an existing container assignment without allocating.
   * Returns the container UUID if the sandbox ID has an active assignment, null otherwise.
   * Used by DELETE to avoid starting a container just to destroy it.
   */
  async lookupContainer(sandboxId: string): Promise<string | null> {
    await this.init();
    const existing = this.assignments.get(sandboxId);
    if (existing) {
      return existing;
    }
    return null;
  }

  /**
   * Report that a container has stopped — removes it from tracking.
   */
  async reportStopped(containerUUID: string): Promise<void> {
    await this.init();
    this.removeContainer(containerUUID);
    await this.persist();
  }

  /**
   * Get current pool statistics.
   */
  async getStats(): Promise<PoolStats> {
    await this.init();
    return {
      warm: this.warmContainers.size,
      assigned: this.assignments.size,
      total: this.warmContainers.size + this.assignments.size,
      config: this.config,
      maxInstances: this.knownMaxInstances
    };
  }

  /**
   * Update pool configuration. Idempotent — called on every request to keep
   * config in sync with wrangler vars across deploys.
   */
  async configure(config: WarmPoolConfig): Promise<void> {
    await this.init();
    this.config = { ...DEFAULT_CONFIG, ...config };
    await this.ctx.storage.put('config', this.config);
  }

  /**
   * Shutdown all pre-warmed (unassigned) containers.
   * Does not affect containers that are assigned to sandbox IDs.
   */
  async shutdownPrewarmed(): Promise<void> {
    await this.init();

    for (const containerUUID of [...this.warmContainers]) {
      try {
        const stub = this.getSandboxStub(containerUUID);
        await (stub as unknown as ContainerRpc).stop();
        this.warmContainers.delete(containerUUID);
      } catch (error) {
        console.error({
          message: 'Failed to stop container',
          component: 'warm-pool',
          containerUUID,
          error
        });
      }
    }

    await this.persist();
  }

  // =======================================================================
  // Alarm handler
  // =======================================================================

  async alarm(): Promise<void> {
    await this.init();

    this.capacityExhausted = false;

    try {
      await this.checkContainerHealth();
      await this.adjustPool();
      await this.keepWarmContainersAlive();
    } catch (error) {
      console.error({
        message: 'Alarm handler error',
        component: 'warm-pool',
        error
      });
    }

    await this.ctx.storage.setAlarm(Date.now() + this.config.refreshInterval);
  }

  // =======================================================================
  // Private — initialisation & persistence
  // =======================================================================

  private async init(): Promise<void> {
    if (this.initialized) return;

    const storedWarm =
      await this.ctx.storage.get<Set<string>>('warmContainers');
    if (storedWarm) this.warmContainers = new Set(storedWarm);

    const storedAssignments =
      await this.ctx.storage.get<Map<string, string>>('assignments');
    if (storedAssignments) this.assignments = new Map(storedAssignments);

    const storedConfig = await this.ctx.storage.get<WarmPoolConfig>('config');
    if (storedConfig) this.config = { ...DEFAULT_CONFIG, ...storedConfig };

    const storedMax = await this.ctx.storage.get<number>('knownMaxInstances');
    if (storedMax !== undefined) this.knownMaxInstances = storedMax;

    this.initialized = true;
    await this.scheduleRefresh();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('warmContainers', this.warmContainers);
    await this.ctx.storage.put('assignments', this.assignments);
    if (this.knownMaxInstances !== null) {
      await this.ctx.storage.put('knownMaxInstances', this.knownMaxInstances);
    } else {
      await this.ctx.storage.delete('knownMaxInstances');
    }
  }

  private async scheduleRefresh(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) {
      await this.ctx.storage.setAlarm(Date.now() + this.config.refreshInterval);
    }
  }

  // =======================================================================
  // Private — container lifecycle
  // =======================================================================

  private async startContainer(): Promise<string | null> {
    const containerUUID = crypto.randomUUID();
    this.startingContainers.add(containerUUID);

    try {
      const stub = this.getSandboxStub(containerUUID);
      await (stub as unknown as ContainerRpc).startAndWaitForPorts();
      console.info({
        message: 'Container started',
        component: 'warm-pool',
        containerUUID
      });
      return containerUUID;
    } catch (error) {
      if (this.isMaxInstancesError(error)) {
        await this.recordCapacityLimit();
      } else {
        console.error({
          message: 'Failed to start container',
          component: 'warm-pool',
          containerUUID,
          error
        });
      }
      return null;
    } finally {
      this.startingContainers.delete(containerUUID);
    }
  }

  private async isContainerRunning(containerUUID: string): Promise<boolean> {
    if (this.startingContainers.has(containerUUID)) return true;

    try {
      const stub = this.getSandboxStub(containerUUID);
      const state = await (stub as unknown as ContainerWithState).getState();
      return state.status === 'running' || state.status === 'healthy';
    } catch (error) {
      console.warn({
        message: 'Failed to check container status, assuming stopped',
        component: 'warm-pool',
        containerUUID,
        error
      });
      return false;
    }
  }

  private async checkContainerHealth(): Promise<void> {
    const allUUIDs = [...this.warmContainers, ...this.assignments.values()];

    let anyRemoved = false;
    for (const uuid of allUUIDs) {
      const running = await this.isContainerRunning(uuid);
      if (!running) {
        console.info({
          message: 'Container not running, removing from pool',
          component: 'warm-pool',
          containerUUID: uuid
        });
        if (this.removeContainer(uuid)) anyRemoved = true;
      }
    }

    if (anyRemoved) await this.persist();
  }

  /**
   * Renew activity timeout on all warm containers to prevent them from sleeping.
   */
  private async keepWarmContainersAlive(): Promise<void> {
    for (const containerUUID of this.warmContainers) {
      try {
        const stub = this.getSandboxStub(containerUUID);
        (stub as unknown as ContainerRpc).renewActivityTimeout();
      } catch (error) {
        console.error({
          message: 'Failed to renew activity timeout',
          component: 'warm-pool',
          containerUUID,
          error
        });
      }
    }
  }

  /**
   * Scale the warm pool towards warmTarget, respecting inferred max_instances.
   */
  private async adjustPool(): Promise<void> {
    let diff = this.config.warmTarget - this.warmContainers.size;

    if (diff > 0) {
      const capacity = this.remainingCapacity();

      // Probe with one start to detect if max_instances was increased
      if (capacity === 0 && this.knownMaxInstances !== null) {
        console.info({
          message: 'Pool at inferred limit, probing for capacity changes',
          component: 'warm-pool',
          knownMaxInstances: this.knownMaxInstances
        });
        const probeUUID = await this.startContainer();
        if (probeUUID) {
          console.info({
            message: 'Probe succeeded, clearing cached limit',
            component: 'warm-pool'
          });
          this.knownMaxInstances = null;
          this.warmContainers.add(probeUUID);
          diff--;
          await this.persist();
        } else {
          await this.persist();
          return;
        }
      }

      const toStart = Math.min(diff, this.remainingCapacity());
      if (toStart <= 0) {
        console.log({
          message: 'Cannot scale up pool',
          component: 'warm-pool',
          needed: diff,
          available: this.remainingCapacity(),
          warm: this.warmContainers.size,
          assigned: this.assignments.size,
          knownMaxInstances: this.knownMaxInstances ?? 'unknown'
        });
        return;
      }

      console.info({
        message: 'Scaling up pool',
        component: 'warm-pool',
        starting: toStart,
        needed: diff,
        capacity: this.remainingCapacity()
      });
      for (let i = 0; i < toStart; i++) {
        if (this.capacityExhausted) {
          console.log({
            message: 'Capacity exhausted mid-loop, stopping further starts',
            component: 'warm-pool'
          });
          break;
        }
        const uuid = await this.startContainer();
        if (uuid) this.warmContainers.add(uuid);
      }
      await this.persist();
    } else if (diff < 0) {
      const excess = -diff;
      console.info({
        message: 'Scaling down pool',
        component: 'warm-pool',
        stopping: excess
      });

      const toStop = [...this.warmContainers].slice(0, excess);
      const stopped: string[] = [];

      for (const uuid of toStop) {
        try {
          const stub = this.getSandboxStub(uuid);
          await (stub as unknown as ContainerRpc).stop();
          stopped.push(uuid);
        } catch (error) {
          console.error({
            message: 'Failed to stop container',
            component: 'warm-pool',
            containerUUID: uuid,
            error
          });
        }
      }

      for (const uuid of stopped) {
        this.warmContainers.delete(uuid);
      }
      await this.persist();
    }
  }

  // =======================================================================
  // Private — helpers
  // =======================================================================

  private removeContainer(containerUUID: string): boolean {
    let removed = false;

    if (this.warmContainers.delete(containerUUID)) removed = true;

    for (const [sandboxId, uuid] of this.assignments) {
      if (uuid === containerUUID) {
        this.assignments.delete(sandboxId);
        removed = true;
        break;
      }
    }

    return removed;
  }

  private remainingCapacity(): number {
    if (this.knownMaxInstances === null) return Infinity;
    return Math.max(
      0,
      this.knownMaxInstances -
        (this.warmContainers.size + this.assignments.size)
    );
  }

  private isMaxInstancesError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(
      'Maximum number of running container instances exceeded'
    );
  }

  private async recordCapacityLimit(): Promise<void> {
    const currentTotal = this.warmContainers.size + this.assignments.size;
    this.knownMaxInstances = currentTotal;
    this.capacityExhausted = true;
    console.warn({
      message: 'Hit max_instances limit',
      component: 'warm-pool',
      inferredCeiling: currentTotal,
      warm: this.warmContainers.size,
      assigned: this.assignments.size
    });
    await this.ctx.storage.put('knownMaxInstances', this.knownMaxInstances);
  }

  private throwCapacityError(): never {
    const total = this.warmContainers.size + this.assignments.size;
    throw new Error(
      `Cannot start container: instance limit reached (${total}/${this.knownMaxInstances}). ` +
        'All container slots are in use. Wait for existing containers to stop.'
    );
  }

  private getSandboxStub(containerUUID: string): DurableObjectStub {
    const id = this.env.Sandbox.idFromName(containerUUID);
    return this.env.Sandbox.get(id);
  }
}
