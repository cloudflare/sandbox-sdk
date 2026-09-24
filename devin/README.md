# Devin Outposts on Cloudflare

Run each [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview) session in its own Container. A Worker polls Devin for the outpost's sessions and gives each session a Durable Object, which starts that session's Container, snapshots it when Devin suspends the session, and restores it when the session resumes.

Done when `curl https://<your-worker>.workers.dev/` returns `{"service":"devin-outpost","status":"ok"}` and a new Devin session on your outpost starts working.

## Deploy

You need a Devin outpost ID and a Devin service user token with the **Run outpost workers** permission.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/devin)

The Deploy flow asks for `DEVIN_OUTPOST_ID` and `DEVIN_API_TOKEN`, then creates the Worker, its cron trigger, the Durable Object namespace, and the Container image.

To deploy from your machine instead, you need Node.js 24 and a running Docker daemon:

```sh
npm create cloudflare@latest -- devin-outpost --template=cloudflare/sandbox-sdk/devin
cd devin-outpost
```

Set `DEVIN_OUTPOST_ID` in `wrangler.jsonc`, then add the token and deploy:

```sh
npx wrangler secret put DEVIN_API_TOKEN
npm run deploy
```

## How it works

A cron trigger runs the Worker every minute. Each run polls the Devin API every `DEVIN_RECONCILE_INTERVAL_MS` (10 seconds by default) and stops before the next run starts. Each poll lists the configured outpost's sessions and skips any session whose `metadata.outpost_id` does not match.

The Worker maps each session status to a call on that session's Durable Object:

| Devin status         | Durable Object action                                                                |
| -------------------- | ------------------------------------------------------------------------------------ |
| `pending`, `running` | Start the Container if it is not running, from the session's snapshot if one exists. |
| `suspended`          | Wait for the Devin CLI to exit, snapshot the Container, then destroy it.             |
| `terminated`         | Destroy the Container and forget the snapshot.                                       |
| Anything else        | Log the status and do nothing.                                                       |

Inside the Container, `devin worker start` claims the session and runs it. The Durable Object never calls Devin.

## Snapshots

When Devin suspends a session, the Devin CLI exits. The entrypoint then writes an exit marker and keeps the Container running, because `snapshotContainer()` needs a running Container. On its next poll, the Durable Object finds the marker, saves a snapshot of the Container's root filesystem, stores the snapshot ID, and destroys the Container. When the session resumes, the Container starts from that snapshot and the entrypoint runs `devin worker start` again.

If the Devin CLI exits while the session is still `running`, the Durable Object snapshots the Container and starts a new one from the snapshot.

A snapshot keeps files, installed packages, and Devin's state on disk. It does not keep running processes or memory. If a Container stops before its snapshot is saved, the session resumes from its previous snapshot or from the image.

Terminating a session removes the snapshot ID from the Durable Object. The Worker API has no method to delete the snapshot itself.

## Configuration

| Setting                       | Description                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `DEVIN_OUTPOST_ID`            | Required. The ID of your Devin outpost.                                               |
| `DEVIN_API_TOKEN`             | Required secret. A service user token with the **Run outpost workers** permission.    |
| `DEVIN_API_URL`               | The Outposts API prefix. Defaults to `https://api.devin.ai/opbeta`.                   |
| `WORKER_ID_PREFIX`            | The prefix for the acceptor ID that each Container reports. Defaults to `cf-outpost`. |
| `DEVIN_RECONCILE_INTERVAL_MS` | The time between polls within each cron run. Defaults to `10000`.                     |

## Security

- Each Container receives `DEVIN_API_TOKEN`, because the Devin CLI needs it to claim the session. Code that Devin runs in the Container can read it.
- Devin runs as root with passwordless `sudo` and Internet access. Use separate deployments for work that must not share a token or an account.
- The Worker answers only `GET /`, for health checks.

## Local development

```sh
cp .dev.vars.example .dev.vars
# Set DEVIN_API_TOKEN in .dev.vars and DEVIN_OUTPOST_ID in wrangler.jsonc.
npm run dev
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```
