import type { ExtensionManifest } from './types';

/**
 * Reference echo sidecar used to validate the extension framework end-to-end.
 *
 * The source is shipped inline so it is written to disk as a provisioned asset
 * rather than compiled into the container binary, mirroring how a sidecar
 * extension keeps its runtime out of the core image.
 *
 * It is self-contained plain JS (no imports) so it runs identically under Bun
 * or Node: it opens a unix socket server on `EXT_SOCKET`, speaks the framed
 * request/response protocol, and supports two methods:
 * - `__ping__` -> `"pong"` (health probe)
 * - `echo`     -> echoes back its first argument, emitting an `echo` event first
 */
const ECHO_SIDECAR_SOURCE = String.raw`
const net = require('node:net');

const HEADER = 4;
const socketPath = process.env.EXT_SOCKET;

function encode(frame) {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  const header = Buffer.allocUnsafe(HEADER);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= HEADER) {
      const len = buffer.readUInt32BE(0);
      if (buffer.length < HEADER + len) break;
      const json = buffer.subarray(HEADER, HEADER + len);
      buffer = buffer.subarray(HEADER + len);
      let req;
      try {
        req = JSON.parse(json.toString('utf8'));
      } catch {
        continue;
      }
      handle(socket, req);
    }
  });
});

function handle(socket, req) {
  if (req.t !== 'req') return;
  try {
    if (req.method === '__ping__') {
      socket.write(encode({ t: 'res', id: req.id, ok: true, value: 'pong' }));
      return;
    }
    if (req.method === 'echo') {
      socket.write(
        encode({ t: 'evt', id: req.id, event: 'echo', data: req.args[0] })
      );
      socket.write(
        encode({ t: 'res', id: req.id, ok: true, value: req.args[0] })
      );
      return;
    }
    if (req.method === 'hang') {
      // Never respond - exercises the host's per-call timeout.
      return;
    }
    if (req.method === 'drop') {
      // Close the connection without responding, but keep the process alive -
      // exercises socket-death handling (the bridge must report disconnected).
      socket.destroy();
      return;
    }
    socket.write(
      encode({
        t: 'res',
        id: req.id,
        ok: false,
        error: { message: 'Unknown method: ' + req.method }
      })
    );
  } catch (err) {
    socket.write(
      encode({
        t: 'res',
        id: req.id,
        ok: false,
        error: { message: String((err && err.message) || err) }
      })
    );
  }
}

server.listen(socketPath, () => {
  process.stdout.write('echo-sidecar listening on ' + socketPath + '\n');
});
`;

/** Manifest for the reference echo extension. */
export function buildEchoManifest(): ExtensionManifest {
  return {
    id: 'echo',
    version: '1',
    assets: [{ path: 'echo-sidecar.cjs', content: ECHO_SIDECAR_SOURCE }],
    command: ['bun', '{dir}/echo-sidecar.cjs'],
    readinessTimeoutMs: 10_000
  };
}

export { ECHO_SIDECAR_SOURCE };
