export type ResourceActivityAvailability = 'available' | 'absent' | 'unknown';

export type ResourceActivityProbe = {
  availability: () => Promise<ResourceActivityAvailability>;
  processesHasActive: () => Promise<boolean>;
  terminalsHasActive: () => Promise<boolean>;
};

export type ResourceActivityOperation = {
  beforeCall: Promise<void>;
  finish: () => void;
};

export class ResourceActivityGate {
  private generation = 0;
  private activityInFlight = 0;
  private nonWakingInFlight = 0;
  private committedStop: Promise<void> | null = null;

  constructor(
    private readonly renewActivity: () => void,
    private readonly stopInactive: () => Promise<void>
  ) {}

  recordActivity(): void {
    this.generation += 1;
    this.renewActivity();
  }

  beginOperation(): ResourceActivityOperation {
    return this.beginTrackedOperation(true);
  }

  /**
   * Admits observation of an already-live runtime without renewing activity.
   * A committed inactivity stop remains authoritative: observers await it and
   * then inspect the resulting inactive state without restarting the runtime.
   */
  beginNonWakingOperation(): ResourceActivityOperation {
    return this.beginTrackedOperation(false);
  }

  private beginTrackedOperation(renew: boolean): ResourceActivityOperation {
    if (renew) {
      this.recordActivity();
      this.activityInFlight += 1;
    } else {
      this.nonWakingInFlight += 1;
    }
    let finished = false;
    const stopToAwait = this.committedStop;

    return {
      beforeCall: stopToAwait
        ? stopToAwait.then(() => {
            if (renew) this.recordActivity();
          })
        : Promise.resolve(),
      finish: () => {
        if (finished) return;
        finished = true;
        if (renew) {
          this.activityInFlight -= 1;
          if (this.activityInFlight === 0) this.recordActivity();
        } else {
          this.nonWakingInFlight -= 1;
        }
      }
    };
  }

  async runExpiry(
    probe: ResourceActivityProbe,
    keepAlive: boolean
  ): Promise<void> {
    if (keepAlive) return;
    if (this.committedStop) {
      await this.commitStop();
      return;
    }
    const generation = this.generation;
    const activityInFlight = this.activityInFlight;
    const nonWakingInFlight = this.nonWakingInFlight;
    if (activityInFlight > 0) {
      this.recordActivity();
      return;
    }
    if (nonWakingInFlight > 0) return;

    let availability: ResourceActivityAvailability;
    try {
      availability = await probe.availability();
    } catch {
      this.recordActivity();
      return;
    }
    if (availability === 'unknown') {
      this.recordActivity();
      return;
    }
    if (
      this.expiryInvalidated(generation, activityInFlight, nonWakingInFlight)
    ) {
      return;
    }

    if (availability === 'absent') {
      await this.commitStop();
      return;
    }

    let processesActive: boolean;
    try {
      processesActive = await probe.processesHasActive();
    } catch {
      this.recordActivity();
      return;
    }
    if (processesActive) {
      this.recordActivity();
      return;
    }
    if (
      this.expiryInvalidated(generation, activityInFlight, nonWakingInFlight)
    ) {
      return;
    }

    let terminalsActive: boolean;
    try {
      terminalsActive = await probe.terminalsHasActive();
    } catch {
      this.recordActivity();
      return;
    }
    if (terminalsActive) {
      this.recordActivity();
      return;
    }
    if (
      this.expiryInvalidated(generation, activityInFlight, nonWakingInFlight)
    ) {
      return;
    }

    await this.commitStop();
  }

  private expiryInvalidated(
    generation: number,
    activityInFlight: number,
    nonWakingInFlight: number
  ): boolean {
    if (
      this.generation !== generation ||
      this.activityInFlight !== activityInFlight
    ) {
      this.recordActivity();
      return true;
    }
    return this.nonWakingInFlight !== nonWakingInFlight;
  }

  private async commitStop(): Promise<void> {
    if (!this.committedStop) {
      this.committedStop = this.stopInactive().finally(() => {
        this.committedStop = null;
        this.recordActivity();
      });
    }
    await this.committedStop;
  }
}
