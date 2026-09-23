# Terminal workspace

Deploy this Worker to open a live shell in a named Container from your browser. The shell runs in a tmux session, so it keeps running when the page closes or the connection drops. For the walkthrough, see [Open a terminal in a sandbox](../../docs/open-a-terminal.md).

Done when the page shows a prompt, `stty size` changes when you resize the window, and reloading the page returns to the same shell.

```sh
npm run example:terminal-workspace:deploy
```

Open the terminal for `agent-1`, keeping the trailing slash:

```txt
$WORKER_URL/sandboxes/agent-1/
```

Start something that keeps printing:

```sh
for i in $(seq 1 600); do echo "line $i"; sleep 1; done
```

Reload the page. It attaches to the same session, and the count has kept going. If the connection drops, the page shows `[Reconnecting in 1 s]` and attaches again. Scroll back with the mouse wheel, and press `q` to leave scrollback. To select text for the clipboard, hold `Shift` while dragging, or `Option` on macOS.

Open the same URL in a second tab. Both tabs show the same screen, and either can type. When the tabs are different sizes, tmux fits the screen to the tab used most recently and fills the rest of a larger tab with dots. Add `?session=build` to open a separate shell in the same Container. Open `/sandboxes/agent-2/` to confirm sandboxes are isolated.

List the sessions, then end one, which closes its open terminals:

```sh
curl "$WORKER_URL/sandboxes/agent-1/sessions"
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/sessions/build"
```

Run `exit` in the shell. The session ends, and the page shows `[Terminal closed with code 0]` without reconnecting. Detaching with `Ctrl+B` then `D` closes the page the same way but keeps the session. Reload to attach again.

Reset that Container, which ends every session:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

Open terminals end with `[Terminal closed with code 137]`, and the next terminal starts on a fresh disk. Workers Logs records `Network connection lost.` on each of those terminal requests. The runtime reports it when the Container is destroyed under a running terminal, and the Worker cannot catch it.

Sessions end when the Container stops, for example after its 10-minute inactivity timeout.

Authenticate in production. This Worker gives anyone who opens the page a `root` shell.
