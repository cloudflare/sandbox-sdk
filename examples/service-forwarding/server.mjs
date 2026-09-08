import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = 8080;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://container");
  if (url.pathname === "/" || url.pathname === "") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("hello from the sandbox service\n");
    return;
  }
  if (url.pathname === "/headers") {
    const body = JSON.stringify({
      method: request.method,
      url: request.url,
      host: request.headers.host ?? null,
      cookie: request.headers.cookie ?? null,
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "guest=1; Path=/",
    });
    response.end(body);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found\n");
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (key === undefined || Array.isArray(key)) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(encodeFrame(1, Buffer.from("ready")));
  let buffered = Buffer.alloc(0);
  socket.on("data", (data) => {
    buffered = Buffer.concat([buffered, data]);
    while (true) {
      const decoded = decodeFrame(buffered);
      if (decoded === null) break;
      buffered = buffered.subarray(decoded.bytes);
      if (decoded.opcode === 8) {
        socket.write(encodeFrame(8, decoded.payload));
        socket.end();
        continue;
      }
      if (decoded.opcode === 9) {
        socket.write(encodeFrame(10, decoded.payload));
        continue;
      }
      if (decoded.opcode === 1 || decoded.opcode === 2) {
        socket.write(encodeFrame(decoded.opcode, decoded.payload));
      }
    }
  });
});

server.listen(PORT, "0.0.0.0");

function encodeFrame(opcode, payload) {
  const first = 0x80 | opcode;
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  }
  throw new Error("example WebSocket payload is too large");
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  const length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126 || length === 127) return null;
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskBytes;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== null) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, bytes: offset + length };
}
