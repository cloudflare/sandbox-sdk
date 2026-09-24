# Open a terminal in a sandbox

Give a person a live shell in a named Container from a web page, and keep it running when the connection drops. Done when the page shows a prompt, `stty size` matches the browser window, and a reload returns to the same shell.

Your Worker serves a page that runs [xterm.js](https://xtermjs.org/). The page opens a WebSocket. The Durable Object runs a [tmux](https://github.com/tmux/tmux/wiki) client on a pseudo-terminal and connects it to the WebSocket. The client attaches to a named tmux session, which holds the shell. When the WebSocket closes, the client ends, and the session keeps running for the next one. The [terminal workspace example](../examples/terminal-workspace) is the complete Worker.

## 1. Build the image

Install tmux and the tools people will use. Turn on tmux mouse mode, so the mouse wheel scrolls back through output, and raise the history limit.

Done when the image runs `tmux -V`.

```dockerfile
FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux \
  && rm -rf /var/lib/apt/lists/*
RUN printf 'set -g mouse on\nset -g history-limit 50000\n' >/etc/tmux.conf
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

## 2. Attach a tmux client for each WebSocket

Start the Container if it is not running. Then run `tmux new-session -A -s <session>` with `pty`. `-A` attaches to the session if it exists, and creates it otherwise. On a pseudo-terminal, the shell shows a prompt, supports line editing, and stops the running command on `Ctrl+C`. Standard output and standard error arrive together on `stdout`.

Done when a WebSocket to `.../terminal?session=main` opens and receives the prompt.

```ts
const abort = new AbortController();
const tmuxClient = await this.#container.exec(["tmux", "new-session", "-A", "-s", session], {
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

Validate the session name. tmux names cannot contain `.` or `:`. The example allows lowercase letters, digits, and hyphens.

Call `accept()`, not the hibernation API. The client's process handle exists only in this Durable Object's memory, and hibernation would discard it. Each WebSocket gets its own client. Clients attached to the same session share its screen, and each person can type. When the tabs are different sizes, tmux fits the screen to the tab used most recently and fills the rest of a larger tab with dots. Different sessions have separate shells on the same disk.

Set `binaryType` to `"arraybuffer"`. Otherwise binary messages arrive as `Blob`.

## 3. Pass keystrokes, output, and resizes

Write binary messages to the client's standard input. Treat text messages as resize requests. Send the client's output to the page unchanged. xterm.js interprets the escape sequences.

Done when you resize the window and `stty size` prints the new size. tmux uses one row for its status line.

```ts
const input = tmuxClient.stdin.getWriter();
server.addEventListener("message", (event) => {
  if (event.data instanceof ArrayBuffer) {
    input.write(new Uint8Array(event.data)).catch(stop);
    return;
  }
  const size = parseSize(event.data);
  if (size !== undefined) tmuxClient.resize(size.cols, size.rows);
});

for await (const chunk of tmuxClient.stdout) server.send(chunk);
server.close(1000, `Terminal closed with code ${await tmuxClient.exitCode}`);
```

The client exits when its session ends or when the person detaches with `Ctrl+B` then `D`. The Durable Object then closes the WebSocket with code `1000`.

Ignore a malformed resize instead of throwing. An exception in a WebSocket listener closes the socket without running the `close` listener, which leaves the client running.

## 4. Stop the client when the connection closes

Abort `exec()` when the WebSocket closes. Aborting sends `SIGKILL` to the tmux client. The session, its shell, and the commands running in it keep going.

Do not signal a client that has already exited. The Container runtime records that as an internal error on the Durable Object invocation. When the client exits, the Durable Object closes the WebSocket, and the `close` listener then runs, so check first:

Done when a command keeps printing while no page is open, and `exit` logs no errors.

```ts
let exited = false;
const markExited = () => {
  exited = true;
};
tmuxClient.exitCode.then(markExited, markExited);
const stop = () => {
  if (!exited) abort.abort();
};
server.addEventListener("close", stop);
server.addEventListener("error", stop);
```

## 5. Serve a page that reconnects

Serve a page that loads xterm.js and its fit add-on. The page sends each keystroke as a binary message, sends `{ "cols": …, "rows": … }` as a text message when the window changes size, and writes every message it receives to the terminal. Pass the initial size and the session in the WebSocket URL.

When the WebSocket closes with any code other than `1000`, the connection dropped. Open a new one after a delay that doubles each time. tmux redraws the screen when the new client attaches, so reset the terminal first.

Done when a dropped connection reconnects to the same shell, and `exit` shows `[Terminal closed with code 0]` without reconnecting.

```js
const terminal = new Terminal({ macOptionClickForcesSelection: true });
let socket;
let reconnectAttempts = 0;

const connect = () => {
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    terminal.reset();
  });
  socket.addEventListener("message", (event) => terminal.write(new Uint8Array(event.data)));
  socket.addEventListener("close", (event) => {
    if (event.code === 1000 || reconnectAttempts >= 10) {
      terminal.writeln(`[${event.reason || "Disconnected"}]`);
      return;
    }
    setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempts++, 30_000));
  });
};
connect();

terminal.onData((data) => socket.send(encoder.encode(data)));
terminal.onResize(({ cols, rows }) => socket.send(JSON.stringify({ cols, rows })));
```

In mouse mode, tmux receives clicks, so dragging selects text in tmux. To select text for the browser clipboard, hold `Shift` while dragging, or `Option` on macOS. `Option` works only with `macOptionClickForcesSelection: true`.

## 6. List and end sessions

List sessions with `tmux list-sessions`. End one with `tmux kill-session`, which ends its shell and every process in it, and closes the terminals attached to it.

Done when a killed session disappears from the list and its open terminals show `[Terminal closed with code 0]`.

```ts
const list = await this.#container.exec([
  "tmux",
  "list-sessions",
  "-F",
  "#{session_name} #{session_attached}",
]);
// "=" matches the name exactly, not as a prefix.
const kill = await this.#container.exec(["tmux", "kill-session", "-t", `=${session}`]);
```

Read each result with `output()`. Both commands exit with a nonzero code when there is no such session. With no sessions at all, the tmux server is not running, and `list-sessions` fails too, so treat that as an empty list.

## Before production

- Authenticate every request. The page gives anyone who opens it a `root` shell in the named sandbox. Derive the sandbox name from the caller's identity.
- Sessions end when the Container stops, for example after its inactivity timeout. Use [background processes](run-background-processes.md) for work that must be tracked, or must keep the Container awake, while nobody is connected.
- Pass numeric user and group IDs in the `user` option of the tmux client's `exec()`, such as `user: "1000:1000"`, if people should not be `root`. A user ID without a group ID runs as `root`.
- Keep `enableInternet: false`, or route outbound requests through a Worker that allows only the hosts people need.
- `WebSocket.send()` does not wait for the browser. A command that prints without stopping, such as `yes`, buffers output in the Durable Object.
- Serve xterm.js from static assets instead of a CDN.
