# Terminal workspace

Deploy this Worker to open a live `bash` shell in a named Container from your browser. For the walkthrough, see [Open a terminal in a sandbox](../../docs/open-a-terminal.md).

Done when the page shows a prompt and `stty size` changes when you resize the window.

```sh
npm run example:terminal-workspace:deploy
```

Open the terminal for `agent-1`, keeping the trailing slash:

```txt
$WORKER_URL/sandboxes/agent-1/
```

Write a file:

```sh
echo hello > /workspace/note.txt
```

Open the same URL in a second tab and run `cat /workspace/note.txt`. Each tab has its own shell in the same Container, so it prints `hello`. Open `/sandboxes/agent-2/` to confirm names are isolated.

Run `exit`. The page shows `[Shell exited with code 0]`. Reload for a new shell.

Reset that Container:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

Open shells end with `[Shell exited with code 137]`, and the next terminal starts on a fresh disk. Workers Logs records `Network connection lost.` on each of those terminal requests. The runtime reports it when the Container is destroyed under a running shell, and the Worker cannot catch it.

Authenticate in production. This Worker gives anyone who opens the page a `root` shell.
