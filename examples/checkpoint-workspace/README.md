# Checkpoint a workspace

Deploy this Worker to save Container disk and start from that snapshot. For the walkthrough, refer to [Checkpoint a workspace](../../docs/checkpoint-a-workspace.md).

Done when a read after checkpoint returns the same bytes you wrote.

```sh
npm run example:checkpoint-workspace:deploy
```

```sh
printf 'state from the source sandbox\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/source/workspace"

curl --request POST "$WORKER_URL/sandboxes/source/checkpoint"
```

The response is a snapshot ID. The next read starts from that snapshot:

```sh
curl "$WORKER_URL/sandboxes/source/workspace"
```

Clone into another Durable Object name:

```sh
curl --request POST \
  "$WORKER_URL/sandboxes/clone/restore?snapshot=$SNAPSHOT_ID"
curl "$WORKER_URL/sandboxes/clone/workspace"
```

Reset destroys the Container and deletes the stored ID:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/source/workspace"
```

Authenticate in production. Treat names and snapshot IDs as owned identities.
