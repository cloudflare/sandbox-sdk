# Move browser terminals

In 0.12, `sandbox.terminal(request)` connected a WebSocket to a shell that the Container kept alive across disconnects, and `SandboxAddon` from `@cloudflare/sandbox/xterm` reconnected the page. Now your Durable Object runs a tmux client on a pseudo-terminal, and a tmux session keeps the shell alive. The page reconnects in about 20 lines of its own code. [Open a terminal in a sandbox](../open-a-terminal.md) builds it step by step. The [terminal workspace example](../../examples/terminal-workspace) is the complete Worker and page.

## 1. Replace `terminal()`

Replace `sandbox.terminal(request, options)` with a `fetch()` handler in your Durable Object that attaches a tmux client and connects it to the WebSocket, as in steps [2](../open-a-terminal.md#2-attach-a-tmux-client-for-each-websocket) to [4](../open-a-terminal.md#4-stop-the-client-when-the-connection-closes) of the how-to. Install tmux in your image.

Done when your terminal route returns `101` and the page shows a prompt.

```ts
// 0.12
return sandbox.terminal(request, { cols: 120, rows: 30 });

// Now, in a Worker route
return env.SANDBOX.getByName(name).fetch(request);
```

`cols` and `rows` become the `pty` option of `exec()`. `shell` becomes the command tmux runs: append it to the `new-session` arguments, such as `["tmux", "new-session", "-A", "-s", session, "zsh"]`. It applies when the session is created.

## 2. Replace sessions

Replace `session.terminal(request)` with a tmux session name. Give each 0.12 session ID its own tmux session. The session's `cwd` and `env` become the `-c` and `-e` arguments of `new-session`, which also apply only when the session is created.

Done when two session names open two separate shells, and two tabs on one session share a screen.

```ts
// 0.12
const session = await sandbox.createSession({
  id: "dev",
  cwd: "/workspace/app",
  env: { NODE_ENV: "development" },
});
return session.terminal(request);

// Now
const argv = [
  "tmux",
  "new-session",
  "-A",
  "-s",
  "dev",
  "-c",
  "/workspace/app",
  "-e",
  "NODE_ENV=development",
];
```

Clients attached to one session share its screen, and each can type, as several 0.12 clients on one session did. Replace `getSession()` and `deleteSession()` with `tmux list-sessions` and `tmux kill-session`, as in [step 6](../open-a-terminal.md#6-list-and-end-sessions). A session no longer shares state with `exec()` calls. Each `exec()` call starts a new process, as in [Change commands and file calls](commands-and-files.md).

## 3. Replace `SandboxAddon`

Remove `@cloudflare/sandbox/xterm`. Open the WebSocket yourself and reconnect when it closes with any code other than `1000`, as in [step 5](../open-a-terminal.md#5-serve-a-page-that-reconnects).

Done when a dropped connection reconnects, and `exit` does not.

| 0.12                                      | Now                                                      |
| ----------------------------------------- | -------------------------------------------------------- |
| `new SandboxAddon({ getWebSocketUrl })`   | Build the WebSocket URL in the page                      |
| `addon.connect({ sandboxId, sessionId })` | `new WebSocket(url)`, with the session in the URL        |
| `addon.disconnect()`                      | `socket.close(1000)`, which the page does not reconnect  |
| `reconnect`                               | The page's `close` listener                              |
| `onStateChange("connecting")`             | Between `new WebSocket()` and `open`                     |
| `onStateChange("connected")`              | The socket's `open` event                                |
| `onStateChange("disconnected", error)`    | The socket's `close` event, with its `code` and `reason` |

0.12 retried 10 times, waiting 1 second and doubling up to 32 seconds. The example also retries 10 times, doubling up to 30 seconds.

## 4. Replace replay

0.12 replayed buffered output into the page on reconnect. tmux redraws the current screen when a client attaches, and keeps up to `history-limit` lines of scrollback in the session.

Done when a reconnected page shows the screen as it was, and the mouse wheel scrolls back through earlier output.

Reset xterm.js when the socket opens, so the redraw starts from a clean screen. Turn on tmux mouse mode in `/etc/tmux.conf`, so the wheel scrolls tmux's history. Scrollback lives in the tmux session, not in the page, and ends with the session.

## 5. Update custom clients

If you wrote your own client for 0.12's terminal protocol, change what it expects from the server. Keystrokes and output are binary messages, as before.

Done when your client handles the close codes below.

| 0.12 message                           | Now                                                          |
| -------------------------------------- | ------------------------------------------------------------ |
| `{ "type": "resize", "cols", "rows" }` | Unchanged. The example ignores `type`.                       |
| `{ "type": "ready" }`                  | The socket's `open` event. The redraw follows.               |
| `{ "type": "exit", "code" }`           | Close code `1000`, reason `Terminal closed with code <code>` |
| `{ "type": "error", "message" }`       | An HTTP error status instead of `101`, such as `400`         |

Close code `1000` also means the person detached with `Ctrl+B` then `D`. The session is still running, and the next connection attaches to it.
