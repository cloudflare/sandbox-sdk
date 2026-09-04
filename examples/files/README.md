# Files

This example keeps all `ContainerFiles` operations in one Worker. It reads and writes
file bytes, inspects metadata, and lists immediate directory entries.

Build the local shim donor and deploy the example:

```sh
npm run example:files:deploy
```

Then use the deployed Worker URL:

```sh
curl "$WORKER_URL/file?sandbox=demo&path=/workspace/fixture.txt"

printf 'saved in the sandbox\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/file?sandbox=demo&path=/workspace/written.txt"

curl "$WORKER_URL/stat?sandbox=demo&path=/workspace/link.txt"
curl "$WORKER_URL/lstat?sandbox=demo&path=/workspace/link.txt"
curl "$WORKER_URL/directory?sandbox=demo&path=/workspace"
```

Destroy the current physical execution when finished:

```sh
curl --request DELETE "$WORKER_URL/execution?sandbox=demo"
```

`sandbox` selects the stable Durable Object identity. The physical execution starts
on the first file operation.
