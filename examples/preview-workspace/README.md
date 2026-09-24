# Preview workspace

Deploy this Worker to run a Vite dev server in a named Container and open it in a browser. Each sandbox gets its own preview origin, `https://<name>.preview.example.com/`. Edits hot-reload. For the walkthrough, see [Preview a web app](../../docs/preview-a-web-app.md).

Done when the preview page shows your edit without a reload.

## Configure the preview domain

Replace `preview.example.com` and `example.com` in `wrangler.jsonc` with a domain on your account. Add a proxied wildcard DNS record for `*.preview.example.com`, and a certificate that covers it. Universal SSL covers `*.example.com`, not `*.preview.example.com`.

## Deploy and preview

```sh
npm run example:preview-workspace:deploy
```

Start the dev server for `agent-1`:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/preview"
```

The response contains the preview URL. Open it in a browser. Then replace the page script:

```sh
printf 'document.querySelector("#app").textContent = "edited";\n\nimport.meta.hot?.accept();\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/agent-1/source"
```

The open page shows `edited`.

If the dev server exits while starting, `POST .../preview` returns `502` with its exit code and log.

Reset that Container:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

The preview returns `503` until the next `POST .../preview`. The next start has a fresh disk.

A reset during a start ends that start with `500`.

Authenticate in production. This Worker runs submitted code, and anyone who knows a preview URL can open it.
