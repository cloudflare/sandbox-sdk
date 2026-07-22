import { WorkerEntrypoint } from 'cloudflare:workers';

const CHECKPOINT_PATH = '/checkpoint';
const MAX_CHECKPOINT_SIZE = 5 * 1024 ** 3;

function checkpointKey(sessionId: string): string {
  return `sessions/${sessionId}.tar.zst`;
}

/** Private streaming bridge between one session container and its R2 object. */
export class CheckpointProxy extends WorkerEntrypoint<
  Env,
  { sessionId: string }
> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== CHECKPOINT_PATH)
      return new Response('Not found', { status: 404 });

    const sessionId = this.ctx.props.sessionId;
    const key = checkpointKey(sessionId);
    switch (request.method) {
      case 'HEAD': {
        // Answer from the session's Durable Object rather than probing R2, so a
        // fresh session with no checkpoint never issues a HeadObject against a
        // missing key (which R2 records as an error-level span).
        const present = await this.#worker(sessionId).hasCheckpoint();
        return new Response(null, { status: present ? 200 : 404 });
      }
      case 'GET': {
        const object = await this.env.DEVIN_CHECKPOINTS.get(key);
        if (!object) return new Response(null, { status: 404 });
        return new Response(object.body, {
          headers: {
            'content-length': String(object.size),
            'content-type': 'application/zstd'
          }
        });
      }
      case 'PUT': {
        const header = request.headers.get('content-length');
        const length = header === null ? NaN : Number(header);
        if (!Number.isSafeInteger(length) || length < 0)
          return new Response('Invalid Content-Length', { status: 400 });
        if (length > MAX_CHECKPOINT_SIZE)
          return new Response('Checkpoint too large', { status: 413 });
        if (!request.body) return new Response('Missing body', { status: 400 });

        const { readable, writable } = new FixedLengthStream(length);
        await Promise.all([
          this.env.DEVIN_CHECKPOINTS.put(key, readable),
          request.body.pipeTo(writable)
        ]);
        await this.#worker(sessionId).recordCheckpointSaved();
        return new Response(null, { status: 204 });
      }
      default:
        return new Response('Method not allowed', {
          status: 405,
          headers: { allow: 'HEAD, GET, PUT' }
        });
    }
  }

  #worker(sessionId: string) {
    return this.env.DevinWorker.get(this.env.DevinWorker.idFromName(sessionId));
  }
}

export async function deleteCheckpoint(
  bucket: R2Bucket,
  sessionId: string
): Promise<void> {
  await bucket.delete(checkpointKey(sessionId));
  console.log(`[${sessionId}] deleted R2 checkpoint`);
}
