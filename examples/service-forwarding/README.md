# Service forwarding

This example forwards HTTP to a guest service with native
`container.getTcpPort(8080).fetch()`. Authentication and public URLs remain
application policy.

Deploy the example:

```sh
npm run example:service-forwarding:deploy
```

Start an execution, then call the guest service:

```sh
curl --request POST "$WORKER_URL/start?sandbox=demo"
curl "$WORKER_URL/service/?sandbox=demo"
curl -D - "$WORKER_URL/service/headers?sandbox=demo"
```

If the first forwarded request fails, retry it. Starting the container does
not wait for port 8080.

Destroy the current physical execution when finished:

```sh
curl --request DELETE "$WORKER_URL/execution?sandbox=demo"
```
