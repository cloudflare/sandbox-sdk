# Command execution

This example runs request-scoped Linux commands with native `container.exec()`.
`@cloudflare/sandbox` is not involved.

Deploy the example:

```sh
npm run example:command-exec:deploy
```

Start an execution, then run an allowed command:

```sh
curl --request POST "$WORKER_URL/start?sandbox=demo"

curl --request POST --header 'content-type: application/json' \
  --data '{"argv":["uname","-a"]}' \
  "$WORKER_URL/exec?sandbox=demo"

curl --request POST --header 'content-type: application/json' \
  --data '{"argv":["cat","/etc/os-release"]}' \
  "$WORKER_URL/exec?sandbox=demo"
```

Destroy the current physical execution when finished:

```sh
curl --request DELETE "$WORKER_URL/execution?sandbox=demo"
```
