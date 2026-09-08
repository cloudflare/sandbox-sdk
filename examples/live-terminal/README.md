# Live terminal

This example connects one WebSocket to one live PTY from native
`container.exec()`. `@cloudflare/sandbox` does not own terminals.

Deploy the example:

```sh
npm run example:live-terminal:deploy
```

Start an execution, then open a WebSocket:

```sh
curl --request POST "$WORKER_URL/start?sandbox=demo"
```

Connect to `$WORKER_URL/pty?sandbox=demo&cols=80&rows=24`. Send terminal input
as binary frames. Send resize as `{"type":"resize","cols":100,"rows":40}`.

Destroy the current physical execution when finished:

```sh
curl --request DELETE "$WORKER_URL/execution?sandbox=demo"
```
