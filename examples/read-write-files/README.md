# Read and write files

This example streams bytes between a Worker request and files in a sandbox container.
It keeps the SDK's file transport separate from container lifecycle policy.

Build the local shim donor and deploy the example:

```sh
npm run example:read-write-files:deploy
```

Then use the deployed Worker URL:

```sh
curl "$WORKER_URL?sandbox=demo&path=/fixture.txt"
printf 'saved in the sandbox\n' | \
  curl --request PUT --data-binary @- "$WORKER_URL?sandbox=demo&path=/written.txt"
curl "$WORKER_URL?sandbox=demo&path=/written.txt"
curl --request DELETE "$WORKER_URL?sandbox=demo"
```

`sandbox` selects the stable Durable Object identity. The physical execution starts
on the first file operation and is destroyed explicitly by `DELETE`.
