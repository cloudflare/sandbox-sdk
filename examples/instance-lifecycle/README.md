# Container instance lifecycle

This example leaves Container Instance lifecycle primitives visible at the
application boundary: startup labels, inactivity, monitoring, graceful termination,
and destructive cleanup.

Build the local shim donor and deploy the example:

```sh
npm run example:instance-lifecycle:deploy
```

Start an execution with non-secret operational labels:

```sh
curl --request POST "$WORKER_URL/start?sandbox=demo"
```

Change its idle timeout or request graceful termination:

```sh
curl --request POST "$WORKER_URL/inactivity?sandbox=demo&ms=30000"
curl --request POST "$WORKER_URL/terminate?sandbox=demo"
```

The graceful termination path uses `monitor()` to wait for the execution to exit.
`DELETE /execution` is the hard cleanup path:

```sh
curl --request DELETE "$WORKER_URL/execution?sandbox=demo"
```

Labels are non-secret operational metadata, not identity or authorization. The
Durable Object name continues to select the logical sandbox.
