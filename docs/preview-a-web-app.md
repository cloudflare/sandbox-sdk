# Preview a web app in a sandbox

Run a dev server in a Container and open it in a browser. Done when an edit written with `Files` appears on the open page without a reload.

Your Worker routes two kinds of request. Control requests start the dev server and write source. Preview requests go to the dev server. The [preview workspace example](../examples/preview-workspace) is the complete Worker.

## 1. Build the image

Install the app and its dependencies at build time. The Container can then run with `enableInternet: false`.

Done when the image runs `./node_modules/.bin/vite --version` in `/workspace/app`.

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-alpine
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
EXPOSE 5173
CMD ["sleep", "infinity"]
```

Pin the port and accept only the preview host:

```js
export default {
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: [process.env.PREVIEW_HOST],
  },
};
```

Without `strictPort`, Vite silently moves to another port when `5173` is taken. Without `allowedHosts`, Vite returns `403` for the preview host.

## 2. Give each sandbox its own origin

Serve `agent-1` at `https://agent-1.preview.example.com/`. Preview pages run code from the sandbox. On their own origin, that code cannot read your app's pages or another sandbox's preview. Frameworks also work unchanged at `/`.

Cookies set with `Domain=example.com` still reach every preview. Serve previews from a domain your app does not use for cookies. A separate registrable domain is safest. Preview code can also set `Domain=preview.example.com` cookies that sibling previews receive. Keep preview cookies host-only, and do not trust a cookie because it arrived on a preview host.

Done when requests for `*.preview.example.com` reach the Worker.

```jsonc
{
  "vars": { "PREVIEW_DOMAIN": "preview.example.com" },
  "routes": [{ "pattern": "*.preview.example.com/*", "zone_name": "example.com" }],
  "workers_dev": true,
}
```

Add a proxied wildcard DNS record for `*.preview.example.com`. Universal SSL covers `*.example.com`, not `*.preview.example.com`. Use an advanced certificate for the deeper wildcard, or a zone that serves only previews.

Map the host to the Durable Object with the same name:

```ts
const previewSuffix = `.${env.PREVIEW_DOMAIN}`;
if (url.hostname.endsWith(previewSuffix)) {
  const sandboxName = url.hostname.slice(0, -previewSuffix.length);
  if (!SANDBOX_NAME_PATTERN.test(sandboxName)) return new Response("Not found", { status: 404 });
  return env.SANDBOX.getByName(sandboxName).fetch(request);
}
```

## 3. Start the dev server

Start it with `exec()`. Write its output to a file and ignore the process streams. A process with piped output is killed by `SIGPIPE` once the request that started it ends.

Done when `POST .../preview` returns `{ "status": "ready" }`.

```ts
const server = await this.#container.exec(
  ["/bin/sh", "-c", `exec ./node_modules/.bin/vite >${DEV_SERVER_LOG_PATH} 2>&1`],
  { cwd: APP_DIRECTORY, env: { PREVIEW_HOST: previewHost }, stdout: "ignore", stderr: "ignore" },
);
```

`start()` does not wait, but the first port request waits until the Container is up. After that, the port fails with `The container is not listening in the TCP address …` until Vite binds it. Retry only that error. Any HTTP response means the server answers.

If Vite exits, the port keeps reporting that nothing is listening. Watch `exitCode` too, or a bad config waits until your deadline:

```ts
const exited = new AbortController();
let exitCode: number | undefined;
server.exitCode.then(
  (code) => {
    exitCode = code;
    exited.abort();
  },
  (cause: unknown) => exited.abort(cause),
);
const signal = AbortSignal.any([exited.signal, AbortSignal.timeout(DEV_SERVER_START_TIMEOUT_MS)]);

while (!signal.aborted) {
  try {
    if (await this.#devServerAnswers(signal)) return ready;
    await scheduler.wait(100, { signal });
  } catch (cause) {
    if (!signal.aborted) throw cause;
  }
}
```

On exit, the example returns the exit code and the log file. Probe once before starting. After a Durable Object restart, the Container and dev server may still be running.

## 4. Forward preview requests

Forward the request unchanged, over HTTP, to the dev server port. HTTP, streaming bodies, and the Vite HMR WebSocket pass through.

Done when the preview URL loads the page and the browser logs `[vite] connected.`

```ts
override async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.protocol = "http:";
  try {
    return await this.#container.getTcpPort(DEV_SERVER_PORT).fetch(new Request(url, request));
  } catch (cause) {
    if (!isNotListening(cause)) {
      console.error({ event: "preview.forward.failed", error: describeError(cause) });
    }
    return new Response("Preview is not running", { status: 503 });
  }
}
```

Preview requests do not start the Container or the dev server. Only the control request does.

Log the error's stack, not the `Error` itself. Workers Logs drops an `Error`'s message and stack when it is nested in a logged object. The example's `describeError()` does this.

## 5. Edit the app

Write source with `Files`. Vite sees the change and pushes an update over the HMR WebSocket.

Done when the open page shows the new text.

```ts
await this.#files.writeFile(SOURCE_PATH, source);
```

## Before production

- Authenticate control requests. This Worker runs code you submit.
- Authenticate preview requests on the preview origin. Do not reuse the control API session there.
- Set `setInactivityTimeout()` in every Durable Object instance. A restarted instance does not inherit the timeout; the example sets it in the constructor when the Container is running.
- Size the instance for your dev server. The example uses `standard-1`.
