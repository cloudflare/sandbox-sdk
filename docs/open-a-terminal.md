# Open a terminal in a sandbox

Give a person a live shell in a named Container from a web page. Done when the page shows a `bash` prompt and `stty size` matches the browser window.

Your Worker serves a page that runs [xterm.js](https://xtermjs.org/). The page opens a WebSocket, and the Durable Object connects it to `bash` running on a pseudo-terminal. The [terminal workspace example](../examples/terminal-workspace) is the complete Worker.

## 1. Build the image

Install the shell and the tools people will use. The example uses `debian:trixie-slim`, which includes `bash`.

Done when the image runs `bash --version`.

```dockerfile
FROM debian:trixie-slim
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

## 2. Start a shell for each WebSocket

Start the Container if it is not running, then pass `pty` to `exec()`. On a pseudo-terminal, `bash` shows a prompt, supports line editing, and stops the running command on `Ctrl+C`. Standard output and standard error arrive together on `stdout`.

Done when a WebSocket to `.../terminal` opens and receives the prompt.

```ts
const abort = new AbortController();
const shell = await this.#container.exec(["bash", "--login"], {
  pty: { cols, rows },
  env: { TERM: "xterm-256color" },
  cwd: "/workspace",
  signal: abort.signal,
});

const [client, server] = Object.values(new WebSocketPair());
server.binaryType = "arraybuffer";
server.accept();
return new Response(null, { status: 101, webSocket: client });
```

Call `accept()`, not the hibernation API. The shell's process handle exists only in this Durable Object's memory, and hibernation would discard it. Each WebSocket gets its own shell. Two tabs open on the same sandbox share its disk.

Set `binaryType` to `"arraybuffer"`. Otherwise binary messages arrive as `Blob`.

## 3. Pass keystrokes, output, and resizes

Write binary messages to the shell's standard input. Treat text messages as resize requests. Send the shell's output to the page unchanged. xterm.js interprets the escape sequences.

Done when you resize the window and `stty size` prints the new rows and columns.

```ts
const input = shell.stdin.getWriter();
server.addEventListener("message", (event) => {
  if (event.data instanceof ArrayBuffer) {
    input.write(new Uint8Array(event.data)).catch(stop);
    return;
  }
  const size = parseSize(event.data);
  if (size !== undefined) shell.resize(size.cols, size.rows);
});

for await (const chunk of shell.stdout) server.send(chunk);
server.close(1000, `Shell exited with code ${await shell.exitCode}`);
```

Ignore a malformed resize instead of throwing. An exception in a WebSocket listener closes the socket without running the `close` listener, which leaves the shell running.

## 4. Stop the shell when the page closes

Abort `exec()` when the WebSocket closes. Aborting sends `SIGKILL` to `bash`, and the foreground command ends with it. Commands started in the background with `&` keep running until the Container stops.

Do not signal a shell that has already exited. The Container runtime records that as an internal error on the Durable Object invocation. When the shell exits, the Durable Object closes the WebSocket, and the `close` listener then runs, so check first:

Done when closing the tab ends a running `sleep`, and `exit` logs no errors.

```ts
let exited = false;
const markExited = () => {
  exited = true;
};
shell.exitCode.then(markExited, markExited);
const stop = () => {
  if (!exited) abort.abort();
};
server.addEventListener("close", stop);
server.addEventListener("error", stop);
```

Reloading the page starts a new shell. Output from the previous shell is not kept, and a dropped connection cannot reattach to its shell.

## 5. Serve the page

Serve a page that loads xterm.js and its fit add-on. The page sends each keystroke as a binary message, sends `{ "cols": …, "rows": … }` as a text message when the window changes size, and writes every message it receives to the terminal.

Done when `https://<worker>/sandboxes/agent-1/` shows a prompt.

```js
const socket = new WebSocket(url);
socket.binaryType = "arraybuffer";
socket.addEventListener("message", (event) => terminal.write(new Uint8Array(event.data)));
terminal.onData((data) => socket.send(encoder.encode(data)));
terminal.onResize(({ cols, rows }) => socket.send(JSON.stringify({ cols, rows })));
```

Pass the initial size in the WebSocket URL, so the shell starts at the right size.

## Before production

- Authenticate every request. The page gives anyone who opens it a `root` shell in the named sandbox. Derive the sandbox name from the caller's identity.
- Run the shell as another Linux user with the `user` option of `exec()` if people should not be `root`.
- Keep `enableInternet: false`, or route outbound requests through a Worker that allows only the hosts people need.
- `WebSocket.send()` does not wait for the browser. A command that prints without stopping, such as `yes`, buffers output in the Durable Object.
- Serve xterm.js from static assets instead of a CDN.
