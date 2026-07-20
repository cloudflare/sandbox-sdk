import { DurableObject } from 'cloudflare:workers';
import { deleteCheckpoint } from './persistence';
import { reconcile } from './reconcile';

export { CheckpointProxy } from './persistence';

/**
 * One Durable Object per Devin session. The DO is deliberately dumb: it knows
 * how to start/stop its Cloudflare Container, but it does not call Devin and it
 * does not interpret Devin statuses. The top-level reconcile loop maps the
 * documented Devin statuses to explicit commands and passes those here.
 */
export class DevinWorker extends DurableObject<Env> {
  #starting?: Promise<void>;

  async ensureRunning(
    sessionId: string,
    outpostId: string,
    acceptorId: string
  ): Promise<void> {
    if (!this.ctx.container)
      throw new Error('No container binding on this Durable Object');
    if (this.ctx.container.running) return;

    if (!this.#starting)
      this.#starting = this.#startContainer(sessionId, outpostId, acceptorId);
    const starting = this.#starting;
    try {
      await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  async stop(sessionId: string, reason: string): Promise<void> {
    // On sleep the Devin CLI exits naturally and the entrypoint saves before
    // the container exits. Destroying here would interrupt that checkpoint.
    if (reason === 'suspended') return;

    await this.#starting;
    await this.#stopContainer(sessionId, reason);
    if (reason === 'terminated')
      await deleteCheckpoint(this.env.DEVIN_CHECKPOINTS, sessionId);
  }

  async #startContainer(
    sessionId: string,
    outpostId: string,
    acceptorId: string
  ): Promise<void> {
    const container = this.ctx.container!;
    await container.interceptOutboundHttp(
      'checkpoint.internal',
      this.ctx.exports.CheckpointProxy({ props: { sessionId } })
    );

    const env: Record<string, string> = {
      DEVIN_OUTPOST_SESSION_ID: sessionId,
      DEVIN_OUTPOST_ID: outpostId,
      DEVIN_WORKER_ACCEPTOR_ID: acceptorId,
      DEVIN_API_TOKEN: this.env.DEVIN_API_TOKEN,
      // The CLI expects an origin and appends its own Outposts API path.
      DEVIN_API_URL: new URL(this.env.DEVIN_API_URL).origin,
      DEVIN_OUTPOST_DESKTOP: 'true',
      DEVIN_CHROME_PATH: '/usr/bin/chromium',
      HOME: '/root',
      USER: 'root',
      LOGNAME: 'root',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8'
    };
    console.log(`[${sessionId}] starting container (outpost=${outpostId})`);
    container.start({ enableInternet: true, env });
    // Log exit; the next poll tick reconciles against the latest supported
    // status. Unknown statuses/errors leave the container unchanged.
    this.ctx.waitUntil(
      container.monitor().then(
        () => console.log(`[${sessionId}] container exited`),
        (err) => console.warn(`[${sessionId}] container exited: ${err}`)
      )
    );
  }

  async #stopContainer(sessionId: string, reason: string): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    console.log(`[${sessionId}] stopping container (${reason})`);
    try {
      await container.destroy();
    } catch (err) {
      console.error(`[${sessionId}] container stop failed`, err);
      throw err;
    }
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/')
      return new Response('Not found', { status: 404 });
    return Response.json({ service: 'devin-outpost', status: 'ok' });
  },

  async scheduled(_: ScheduledEvent, env: Env): Promise<void> {
    console.log('reconcile', await reconcile(env));
  }
};
