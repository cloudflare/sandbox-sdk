# Minimal sandbox

Start a project with a Worker, a Durable Object, and a Container that already work together. The Worker sends each request to a Durable Object by name. The Durable Object starts its Container, reads and writes files with `Files`, and runs commands with `exec()`.

Done when `POST .../exec` returns `hello` in `stdout`.

## Create a project

```sh
npm create cloudflare@latest -- my-sandbox --template=cloudflare/sandbox-sdk/examples/minimal
```

Or deploy it directly:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/examples/minimal)

Wrangler builds the image, so deploying needs a running Docker daemon.

```sh
npm run deploy
```

## Try it

Run a command:

```sh
curl --request POST --header "Content-Type: application/json" \
  --data '{"argv": ["echo", "hello"]}' \
  "$WORKER_URL/sandboxes/demo/exec"
```

Write a file and read it back. File paths are relative to `/workspace`:

```sh
printf 'hello from a file\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/demo/files/notes.txt"

curl "$WORKER_URL/sandboxes/demo/files/notes.txt"
```

Each name has its own Container. Destroy one:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/demo"
```

The Durable Object remains. The next request starts a fresh Container from the image.

## Before production

This Worker runs any command it receives. Authenticate requests, derive the sandbox name from your user or job, and allow only the commands you intend.

The `Dockerfile` copies the helper that `Files` uses from `docker.io/cloudflare/sandbox`. Keep that tag equal to the installed `@cloudflare/sandbox` version. Replace `FROM alpine` with the base image your work needs.

## Next steps

- [Run a Linux task](https://github.com/cloudflare/sandbox-sdk/blob/main/docs/get-started.md)
- [Files API](https://github.com/cloudflare/sandbox-sdk/blob/main/docs/files.md)
- [Checkpoint a workspace](https://github.com/cloudflare/sandbox-sdk/blob/main/docs/checkpoint-a-workspace.md)
