# Files

This example keeps all `ContainerFiles` operations in one Worker. It transfers file
bytes, inspects metadata, lists directory entries, and mutates workspace paths.

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

curl --request PUT \
  "$WORKER_URL/directory?sandbox=demo&path=/workspace/created"

curl --request PUT \
  "$WORKER_URL/directory?sandbox=demo&path=/workspace/created/nested&recursive=true"

curl --request POST \
  "$WORKER_URL/rename?sandbox=demo&path=/workspace/rename-source.txt&destination=/workspace/rename-destination.txt"

curl --request DELETE \
  "$WORKER_URL/remove?sandbox=demo&path=/workspace/remove-file.txt"

curl --request DELETE \
  "$WORKER_URL/remove?sandbox=demo&path=/workspace/remove-directory&recursive=true"
```

Destroy the current physical execution when finished:

```sh
curl --request DELETE "$WORKER_URL/execution?sandbox=demo"
```

`sandbox` selects the stable Durable Object identity. The physical execution starts
on the first file operation.
