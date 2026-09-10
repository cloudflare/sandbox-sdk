# About sandboxes

A sandbox is an isolated place to run work. Your Worker receives the request, decides what may run, and returns the result.

Cloudflare has two sandbox environments: [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) and [Containers](https://developers.cloudflare.com/containers/). This repository uses Containers.

A Container runs in its own VM. It does not share a process or kernel with your Worker. HTTP from the Internet reaches it only through your Worker.

## Same name, same Durable Object

Call `env.SANDBOX.getByName(name)`. The same name reaches the same Durable Object. A different name is a different Durable Object.

That Durable Object can have one running Container. The Container is not the Durable Object. If the Container stops, the Durable Object remains.

## Disk lasts while the Container runs

Files you write stay on that Container's disk while the instance is running. Destroying it, or letting it time out, drops unsaved files.

To keep files across a restart, call `snapshotContainer()`. Store the snapshot ID in Durable Object storage. Start the next Container with `containerSnapshot`. See [Checkpoint a workspace](checkpoint-a-workspace.md).

To clone a workspace, start a different Durable Object from the same snapshot.

Snapshots capture disk. They do not capture running processes or memory.

## Your Worker is the boundary

Authenticate the request in the Worker. Choose the Durable Object name. Choose which paths and commands are allowed. Labels on `start()` are operational metadata, not authorization.

`Files` follows Linux path rules. It does not enforce access policy.

## Commands

`container.exec()` starts a process in a running Container. It does not start a stopped Container.

`running` is true while the instance is up. It does not mean the process is ready to accept work. `start()` does not wait until the Container is ready.

The `ExecProcess` handle lives in this Durable Object isolate. If the request is canceled after `exec()` returns, the process may still be running.

## Deploys and images

A new Worker version does not replace a running Container. The image and instance you pass to `start()` apply when that Container starts. A running instance keeps the image it started with.

`@cloudflare/sandbox` is `Files`. Start and destroy Containers yourself. Refer to the [Files API](files.md).
