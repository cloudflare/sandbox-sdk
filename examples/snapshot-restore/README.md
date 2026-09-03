# Snapshot and restore

This example checkpoints a sandbox with the native Container API and stores only its
active snapshot reference in Durable Object storage. The SDK does not wrap snapshot
or lifecycle operations.

Build the local shim donor and deploy the example:

```sh
npm run example:snapshot-restore:deploy
```

Write a workspace file, checkpoint the execution, and read it again from a restored
execution:

```sh
printf 'survives the execution\n' | \
  curl --request PUT --data-binary @- "$WORKER_URL/workspace?sandbox=source"

curl --request POST "$WORKER_URL/checkpoint?sandbox=source"
curl "$WORKER_URL/workspace?sandbox=source"
```

The checkpoint response contains an opaque snapshot ID. To demonstrate an explicit
clone, select that snapshot for a stopped target sandbox and then read it:

```sh
curl --request POST \
  "$WORKER_URL/restore?sandbox=clone&snapshot=$SNAPSHOT_ID"
curl "$WORKER_URL/workspace?sandbox=clone"
```

Resetting a sandbox destroys its current execution and removes its active resume
pointer:

```sh
curl --request DELETE "$WORKER_URL/workspace?sandbox=source"
```

If snapshot restoration fails, the example surfaces the request failure and does not
silently start from the image.
