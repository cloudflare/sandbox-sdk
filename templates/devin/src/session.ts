import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// The reconciler renews this on every poll, so it only matters after polling stops.
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000;
// start-devin-worker writes this file when the Devin CLI exits and then keeps the Container running.
const EXIT_MARKER = "/var/lib/devin-outpost/exited";
const SNAPSHOT_KEY = "snapshotId";

export type SuspendResult = "saved" | "waiting" | "stopped";

/** One Durable Object per Devin session. It controls that session's Container and never calls Devin. */
export class DevinSession extends DurableObject<Env> {
  async ensureRunning(sessionId: string, acceptorId: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) {
      // A running session whose CLI exited needs a new Container. Keep its disk first.
      if (!(await this.saveIfExited(container, sessionId))) {
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        return;
      }
    }

    const snapshotId = await this.ctx.storage.get<string>(SNAPSHOT_KEY);
    const env = {
      DEVIN_OUTPOST_SESSION_ID: sessionId,
      DEVIN_OUTPOST_ID: this.env.DEVIN_OUTPOST_ID,
      DEVIN_WORKER_ACCEPTOR_ID: acceptorId,
      DEVIN_API_TOKEN: this.env.DEVIN_API_TOKEN,
      // The CLI expects an origin and appends its own Outposts API path.
      DEVIN_API_URL: new URL(this.env.DEVIN_API_URL).origin,
      DEVIN_OUTPOST_DESKTOP: "true",
      DEVIN_CHROME_PATH: "/usr/bin/chromium",
      HOME: "/root",
      USER: "root",
      LOGNAME: "root",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
    };
    const options = {
      instance: "standard-2",
      enableInternet: true,
      env,
    } satisfies ContainerStartupOptions;
    if (snapshotId === undefined) {
      container.start({ ...options, image: container.images.devin });
    } else {
      container.start({ ...options, containerSnapshot: { id: snapshotId } });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    console.log({
      event: "devin.container.started",
      sessionId,
      fromSnapshot: snapshotId !== undefined,
    });
    this.ctx.waitUntil(
      container.monitor().then(
        () => console.log({ event: "devin.container.exited", sessionId }),
        (cause: unknown) =>
          console.warn({ event: "devin.container.exited", sessionId, error: describeError(cause) }),
      ),
    );
  }

  // Devin suspends a session by letting its CLI exit. Save the disk once it has.
  async suspend(sessionId: string): Promise<SuspendResult> {
    const container = this.requireContainer();
    if (!container.running) return "stopped";
    if (await this.saveIfExited(container, sessionId)) return "saved";
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return "waiting";
  }

  async terminate(sessionId: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) await container.destroy();
    // The Worker API cannot delete the snapshot itself; forgetting its ID stops any restore.
    await this.ctx.storage.deleteAll();
    console.log({ event: "devin.session.terminated", sessionId });
  }

  private async saveIfExited(container: Container, sessionId: string): Promise<boolean> {
    const probe = await container.exec(["test", "-e", EXIT_MARKER]);
    const { exitCode } = await probe.output();
    if (exitCode !== 0) return false;

    const snapshot = await container.snapshotContainer({ name: `devin-${sessionId}` });
    await this.ctx.storage.put(SNAPSHOT_KEY, snapshot.id);
    await container.destroy();
    console.log({
      event: "devin.snapshot.saved",
      sessionId,
      snapshotId: snapshot.id,
      bytes: snapshot.size,
    });
    return true;
  }

  private requireContainer(): Container {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }
    return container;
  }
}

// Structured logs drop an Error's message and stack because they are not enumerable.
export function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}
