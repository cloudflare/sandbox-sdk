# Checkpoint a workspace

Save Container disk with `snapshotContainer()`, then start again from that snapshot.

Done when a later read returns the same files after you destroy the Container.

The [checkpoint workspace example](../examples/checkpoint-workspace) is the full Worker.

Snapshots capture disk. They do not capture running processes or memory.

## 1. Record the snapshot ID

Keep the snapshot ID in Durable Object storage. The snapshot holds the disk. Storage holds the pointer.

Done when storage contains the ID returned by `snapshotContainer()`.

```ts
interface ActiveCheckpoint {
  id: string;
}

const ACTIVE_CHECKPOINT_KEY = "active-container-checkpoint";

const snapshot = await container.snapshotContainer({});
await this.ctx.storage.put<ActiveCheckpoint>(ACTIVE_CHECKPOINT_KEY, {
  id: snapshot.id,
});
await container.destroy();
```

The Container must be running. `snapshotContainer()` waits until the snapshot is written. Write the ID only after it succeeds. The example then destroys the Container so the next request restores from the snapshot.

## 2. Start from the stored ID

When no Container is running, start from the stored ID, or from the image if none exists. Pass `image` or `containerSnapshot`, not both.

Done when a stopped Durable Object with a stored ID starts via `containerSnapshot`.

```ts
const checkpoint = await this.ctx.storage.get<ActiveCheckpoint>(ACTIVE_CHECKPOINT_KEY);

if (checkpoint === undefined) {
  container.start({
    image: this.env.SANDBOX_IMAGE,
    instance: "lite",
    enableInternet: false,
  });
} else {
  container.start({
    containerSnapshot: { id: checkpoint.id },
    instance: "lite",
    enableInternet: false,
  });
}
```

If restore fails, surface the error. Starting from the image would show an empty disk under a name that should resume.

## 3. Clone with a second name

Store the source snapshot ID on a different Durable Object whose Container is not running. The example throws if that Container is still up. Destroy it first. The new name is a different Durable Object. Its next `start()` uses `containerSnapshot`.

Done when a read on the clone returns the source files.

Your Worker owns catalogs, names, and retention. `Files` does not wrap snapshots.

## 4. Reset

Destroy the running Container and delete the stored ID. The next start uses the image.

Done when a later read starts from the image, not the snapshot.

Deleting the pointer does not delete the platform snapshot.
