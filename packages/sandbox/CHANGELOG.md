# @cloudflare/sandbox

## 0.9.0

### Minor Changes

- [#633](https://github.com/cloudflare/sandbox-sdk/pull/633) [`4e628ae`](https://github.com/cloudflare/sandbox-sdk/commit/4e628ae942a49dda06e1bf68daa669e179f7ffd9) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Handle shell exits with `SessionTerminatedError`, and let the same session id recover on the next call.

  ```ts
  import { SessionTerminatedError } from '@cloudflare/sandbox';

  const session = await sandbox.createSession({ id: 'build' });

  try {
    await session.exec('exit 42');
  } catch (error) {
    if (error instanceof SessionTerminatedError) {
      console.log(error.exitCode); // 42
      await session.exec('echo fresh shell');
    }
  }
  ```

  If a session's shell exits, the failing call now returns `SESSION_TERMINATED`
  (`HTTP 410`) with the observed exit code instead of a generic internal error.
  Retrying with the same session id, or calling `createSession({ id })`, starts a
  fresh session without destroying the whole sandbox. Session-local state such as
  the working directory, environment variables, shell functions, and background
  jobs is lost when the shell exits.

## 0.8.14

### Patch Changes

- [#613](https://github.com/cloudflare/sandbox-sdk/pull/613) [`174313f`](https://github.com/cloudflare/sandbox-sdk/commit/174313fa061be7604df5b3cfd4c1770454b727a6) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Avoid duplicate session-create calls when parallel operations hit a
  fresh sandbox. Parallel callers now share one setup call instead of
  each issuing their own. Sequential operations are unaffected.

  Session setup also now retries cleanly on the next operation if it is
  interrupted partway through — including by a container stop during
  first use — instead of leaving the sandbox in a state that looks
  initialized but references a session the container no longer has.

- [#624](https://github.com/cloudflare/sandbox-sdk/pull/624) [`bbdfd95`](https://github.com/cloudflare/sandbox-sdk/commit/bbdfd95f70bd73a1c18b49dde139662041143d72) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix sandboxes staying alive past their configured `sleepAfter` value.

  Workers that passed configuration options to `getSandbox()` on every request (`sleepAfter`, `keepAlive`, or `containerTimeouts`) could unintentionally extend sandbox lifetimes. The SDK's internal reapply path treated identical reapplied values as activity, resetting the sleep timer each time. Under sustained traffic, sandboxes would never sleep at all.

  After updating, reapplying the same configuration value is a true no-op. Your `getSandbox()` calls continue to work exactly as before; sandboxes now respect their configured sleep timers regardless of how often configuration is reapplied.

  This release also removes the unused `baseUrl` option from `SandboxOptions`, along with the `setBaseUrl` RPC method on the Sandbox Durable Object. The option had no effect on runtime behavior; preview URLs are driven by the `hostname` passed to preview-URL APIs. If you were setting `baseUrl` on `getSandbox()`, you can safely remove it. Directly invoking the undocumented `setBaseUrl` RPC method will now error.

- [#629](https://github.com/cloudflare/sandbox-sdk/pull/629) [`34e3a96`](https://github.com/cloudflare/sandbox-sdk/commit/34e3a968abe2eb5efe0d9461c0a90930ca0e0338) Thanks [@aron-cf](https://github.com/aron-cf)! - Improve reliability of `desktop.stop()` as well as general isolation of the desktop processes by
  running them in a subprocess. This should ensure that processes are cleaned up when calling
  `desktop.stop()` and crashes should not impact the sandbox container service.

- [#576](https://github.com/cloudflare/sandbox-sdk/pull/576) [`9222fd0`](https://github.com/cloudflare/sandbox-sdk/commit/9222fd0c408c9dd51b3f262e203b7c5754d650fb) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix stream controller race condition causing "Invalid state: Controller is already closed" errors

  Resolves an issue where client disconnections during streaming operations could cause unhandled TypeError exceptions, potentially corrupting the SDK bridge state. The fix adds defensive error handling in the execute streaming handler to gracefully handle callbacks firing after stream cancellation.

- [#614](https://github.com/cloudflare/sandbox-sdk/pull/614) [`74a58e9`](https://github.com/cloudflare/sandbox-sdk/commit/74a58e9692534d1c6faee1757a9eba1380335d07) Thanks [@aron-cf](https://github.com/aron-cf)! - Adds a new `transport: 'http' | 'websocket'` field to the `getSandbox()` options. This can be
  used to dynamically select transport on a per-sandbox basis.

  > [!NOTE]
  > Changing transport on an already existing sandbox may result in dropped connections, it is
  > recommended to keep the same transport for the lifetime of the sandbox instance.

  ```ts
  const sandbox = getSandbox(env.Sandbox, 'my-sandbox', {
    transport: 'websocket'
  });
  ```

- [#567](https://github.com/cloudflare/sandbox-sdk/pull/567) [`1c7337a`](https://github.com/cloudflare/sandbox-sdk/commit/1c7337a3dfa414b9dd07e2188fec79cb3136977f) Thanks [@scuffi](https://github.com/scuffi)! - Adds support for local backup and restore through the `BACKUP_BUCKET` R2 binding in local development when `localBucket: true` is set.

## 0.8.13

### Patch Changes

- [#600](https://github.com/cloudflare/sandbox-sdk/pull/600) [`63e6a89`](https://github.com/cloudflare/sandbox-sdk/commit/63e6a898ce293629b4265e781f9b2792177b9606) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix preview URLs returning 404 after a container restart. Tokens and names
  passed to `exposePort()` now persist across restarts, so URLs issued by
  `exposePort()` keep working without re-exposing the port. Tokens are still
  cleared when you call `unexposePort()` or `destroy()`.

- [#611](https://github.com/cloudflare/sandbox-sdk/pull/611) [`5754416`](https://github.com/cloudflare/sandbox-sdk/commit/5754416f67c5bd0f530ff9db06e2b1a975b2a94e) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Speed up preview URL authorization and close a race in `unexposePort()`.
  Preview URL auth checks no longer make an extra round-trip to the
  container runtime, so pages that fetch many assets through a single
  preview URL do less work per request. `unexposePort()` now revokes
  the preview token before signaling the container, so a preview
  request that races an `unexposePort()` call can no longer reach the
  process running inside the sandbox after the token has been revoked.
  `getExposedPorts()` also no longer throws when it encounters a port
  left in an inconsistent state by a failed `unexposePort()`; such
  ports are omitted from the result and logged as a warning.

## 0.8.12

### Patch Changes

- [#593](https://github.com/cloudflare/sandbox-sdk/pull/593) [`3ddf9f4`](https://github.com/cloudflare/sandbox-sdk/commit/3ddf9f49aac20d84fcefa8fcb75a70ca031c144d) Thanks [@scuffi](https://github.com/scuffi)! - Fix `localBucket: true` mount silently syncing nothing when prefix starts with `/`

## 0.8.11

### Patch Changes

- [#585](https://github.com/cloudflare/sandbox-sdk/pull/585) [`ab84333`](https://github.com/cloudflare/sandbox-sdk/commit/ab843334764e0fe0fe268e406f2332d3381bd94e) Thanks [@aron-cf](https://github.com/aron-cf)! - Add the sandbox bridge — an HTTP API that translates REST calls into Sandbox Durable Object operations. Deploy the bridge as a standalone Cloudflare Worker to expose session management, command execution, file read/write, PTY, and workspace mount/unmount over HTTP. Includes an optional warm pool Durable Object for pre-provisioning sandboxes to reduce cold-start latency.

  Import the bridge factory and warm pool from `@cloudflare/sandbox/bridge`.

  ```ts
  import { bridge } from '@cloudflare/sandbox/bridge';
  export { Sandbox } from '@cloudflare/sandbox';
  export { WarmPool } from '@cloudflare/sandbox/bridge';

  export default bridge({
    fetch(request, env, ctx) {
      // your code here
      return new Response('OK');
    }
  });
  ```

## 0.8.10

### Patch Changes

- [#577](https://github.com/cloudflare/sandbox-sdk/pull/577) [`a56898c`](https://github.com/cloudflare/sandbox-sdk/commit/a56898cc83944a5d43ce3ab75cdba8025d51e2fc) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Improve backup restores by mounting backup archives from R2 during restore
  instead of downloading them into local container storage first.

## 0.8.9

### Patch Changes

- [#570](https://github.com/cloudflare/sandbox-sdk/pull/570) [`8363119`](https://github.com/cloudflare/sandbox-sdk/commit/8363119c5cf70a48a81a7a515fb14a9c0ae890be) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix `unmountBucket()` silently succeeding when the FUSE filesystem fails to unmount. The method now checks the `fusermount` exit code and throws `BucketUnmountError` on failure, cleans up the mount directory after a successful unmount, and the container image includes the `/etc/mtab` symlink that `fusermount` requires.

- [#573](https://github.com/cloudflare/sandbox-sdk/pull/573) [`cc14fc7`](https://github.com/cloudflare/sandbox-sdk/commit/cc14fc7e931f7b92cee05010eeb5aa74cc44209b) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Increase the default `gitCheckout()` clone timeout to 10 minutes so larger repositories and slower Git remotes do not fail after 2 minutes by default.
  You can now override the git clone subprocess timeout per call with the `cloneTimeoutMs` option when a checkout needs more time.

## 0.8.8

### Patch Changes

- [#571](https://github.com/cloudflare/sandbox-sdk/pull/571) [`c5db840`](https://github.com/cloudflare/sandbox-sdk/commit/c5db84092ad8d3ea1c0e98b54e1b58d7a953b32b) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Require `@cloudflare/containers` 0.3.0 so sandbox apps pick up the latest Containers platform updates.

## 0.8.7

### Patch Changes

- [#565](https://github.com/cloudflare/sandbox-sdk/pull/565) [`ffcbd3a`](https://github.com/cloudflare/sandbox-sdk/commit/ffcbd3ab9584c7e717f6d4d19538bb57cbd88d69) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Require `@cloudflare/containers` 0.2.3 or newer.

- [#550](https://github.com/cloudflare/sandbox-sdk/pull/550) [`1db32ea`](https://github.com/cloudflare/sandbox-sdk/commit/1db32ea02f1374b4c79d9bf05f50424b4166402b) Thanks [@scuffi](https://github.com/scuffi)! - Setting `interceptHttps = true` on your Sandbox will now automatically trust the Cloudflare-injected CA certificate at container startup, enabling outbound HTTPS traffic interception.

## 0.8.6

### Patch Changes

- [#557](https://github.com/cloudflare/sandbox-sdk/pull/557) [`f17045b`](https://github.com/cloudflare/sandbox-sdk/commit/f17045ba9202d2a1d0e59161b279fd75a31d458f) Thanks [@AshishKumar4](https://github.com/AshishKumar4)! - Fix startup deadlock when using WebSocket transport.

  Sandboxes that call `exec()` or other SDK methods inside `onStart()` could
  get stuck in an infinite timeout loop, requiring a restart. This is now
  handled automatically.

## 0.8.5

### Patch Changes

- [#559](https://github.com/cloudflare/sandbox-sdk/pull/559) [`b42a57f`](https://github.com/cloudflare/sandbox-sdk/commit/b42a57f712a711d8892a07022ff589bbea4bafce) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Allow `createBackup()` and `restoreBackup()` to target directories under `/app`.
  This makes backups work with custom images that keep application files in `/app` instead of `/workspace`.

## 0.8.4

### Patch Changes

- [#542](https://github.com/cloudflare/sandbox-sdk/pull/542) [`eb55c28`](https://github.com/cloudflare/sandbox-sdk/commit/eb55c286ac508a70e53f1f7acfaa4f8c1e84156a) Thanks [@dependabot](https://github.com/apps/dependabot)! - Upgrade Go toolchain to 1.25 and update dependencies in the desktop container variant, including a security fix for image processing (CVE-2026-33809).

## 0.8.3

### Patch Changes

- [#515](https://github.com/cloudflare/sandbox-sdk/pull/515) [`bf54f69`](https://github.com/cloudflare/sandbox-sdk/commit/bf54f696790ed9ef6b83ea4c6d3caef881940f4c) Thanks [@Muhammad-Bin-Ali](https://github.com/Muhammad-Bin-Ali)! - Fix slow parallel code context creation. Creating multiple contexts concurrently (e.g. 10 at once) no longer scales linearly with each request — wall time drops from ~5s to ~500ms.

- [#493](https://github.com/cloudflare/sandbox-sdk/pull/493) [`fdd3efa`](https://github.com/cloudflare/sandbox-sdk/commit/fdd3efa45a97198c7b69c8578885ca29af803680) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add `checkChanges()` for apps that disconnect and reconnect later but still need to know whether files changed in the meantime.

  Use the returned `version` in a later call to learn whether a path is unchanged, changed, or needs a full resync. Retained change state lasts for the current container lifetime only.

## 0.8.2

### Patch Changes

- [#544](https://github.com/cloudflare/sandbox-sdk/pull/544) [`9a2f553`](https://github.com/cloudflare/sandbox-sdk/commit/9a2f553b06cf15a38e629de49d0d7b1d0bec10b7) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Require `@cloudflare/containers` 0.2.2 or newer so long-running streamed commands stay alive past `sleepAfter` while work is still in progress.

## 0.8.1

### Patch Changes

- [#487](https://github.com/cloudflare/sandbox-sdk/pull/487) [`19076fb`](https://github.com/cloudflare/sandbox-sdk/commit/19076fb6c80d2981c2f2e40dcda0911247e81543) Thanks [@scuffi](https://github.com/scuffi)! - Process termination now walks the command's process tree so killing a process also terminates child processes started by that command

## 0.8.0

### Minor Changes

- [#519](https://github.com/cloudflare/sandbox-sdk/pull/519) [`4103149`](https://github.com/cloudflare/sandbox-sdk/commit/41031498a412f2bff125254d8d5b904a508b3847) Thanks [@scuffi](https://github.com/scuffi)! - Add outbound HTTP interception for sandboxes. Define `outbound` or `outboundByHost` handlers on your Sandbox class to intercept, modify, or block HTTP requests made from within the sandbox -- with full access to Workers bindings like KV and R2. `ContainerProxy` is now exported directly from `@cloudflare/sandbox`. Requires `@cloudflare/containers` 0.2.0+.

## 0.7.21

### Patch Changes

- [#523](https://github.com/cloudflare/sandbox-sdk/pull/523) [`e3fd7a6`](https://github.com/cloudflare/sandbox-sdk/commit/e3fd7a69a16bc50c36b80fda44301f326a160b91) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump picomatch

- [#456](https://github.com/cloudflare/sandbox-sdk/pull/456) [`734f16d`](https://github.com/cloudflare/sandbox-sdk/commit/734f16d2b1787f5af6798858842d04d3f8dc1c5e) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Structured logging for Workers Observability and Containers Logs. All operations emit queryable fields (`event`, `outcome`, `durationMs`, `command`, `exitCode`, `sessionId`) that can be filtered and aggregated in the dashboard. Presigned R2 URL parameters and embedded git URL credentials are redacted from all log fields. Set `SANDBOX_LOG_FORMAT=pretty` for readable local dev output.

## 0.7.20

### Patch Changes

- [#500](https://github.com/cloudflare/sandbox-sdk/pull/500) [`fcfb350`](https://github.com/cloudflare/sandbox-sdk/commit/fcfb35021860927548cd7209f6fc7bea38c53e04) Thanks [@aron-cf](https://github.com/aron-cf)! - Bump wrangler to 4.76.0

- [#486](https://github.com/cloudflare/sandbox-sdk/pull/486) [`db66675`](https://github.com/cloudflare/sandbox-sdk/commit/db66675d437de051384fc6802c30d0785decfaec) Thanks [@berry1001](https://github.com/berry1001)! - Fix supervisor-mode sandbox shutdown so inactivity `SIGTERM` cleanly exits the `/sandbox` process even when the user CMD has already exited or daemonized work in the background.

## 0.7.19

### Patch Changes

- [#503](https://github.com/cloudflare/sandbox-sdk/pull/503) [`05caafc`](https://github.com/cloudflare/sandbox-sdk/commit/05caafc1a746bc98e293776836bb9ae1fdd2f332) Thanks [@scuffi](https://github.com/scuffi)! - Add automatic detection of S3 credentials when mounting buckets. Now we do not need to explicitly declare credentials when mounting buckets if they are set as environment variables in the Durable Object.

- [`1c3b75b`](https://github.com/cloudflare/sandbox-sdk/commit/1c3b75b00b3514fbd54ffca7735da5ca3899c6fc) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix `sleepAfter` configuration silently reverting to the default after the sandbox restarts. The configured sleep timeout is now retained reliably across the sandbox lifecycle.

- [#507](https://github.com/cloudflare/sandbox-sdk/pull/507) [`5e55a38`](https://github.com/cloudflare/sandbox-sdk/commit/5e55a38280f96a84b145d8c4074eb71b4d3f15ff) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Reduce waitIntervalMS default to 300ms

## 0.7.18

### Patch Changes

- [#363](https://github.com/cloudflare/sandbox-sdk/pull/363) [`60967cd`](https://github.com/cloudflare/sandbox-sdk/commit/60967cd15e82929efbbacee00cdfb80d457b3b10) Thanks [@Destreyf](https://github.com/Destreyf)! - Add custom environment variable support to OpenCode integration.
  Enable with `env` in `OpencodeOptions` to pass variables like OTEL endpoints or trace context.

- [#489](https://github.com/cloudflare/sandbox-sdk/pull/489) [`80da532`](https://github.com/cloudflare/sandbox-sdk/commit/80da5321e9154d58ed24db0bb1aa822ed0b70c84) Thanks [@maschwenk](https://github.com/maschwenk)! - Fix environment variables not being inherited by PTY sessions opened via `sandbox.terminal`. Variables set with `setEnvVars()` were not being passed to the terminal environment.

- [#468](https://github.com/cloudflare/sandbox-sdk/pull/468) [`378a85c`](https://github.com/cloudflare/sandbox-sdk/commit/378a85c2815755d22ea398a12cf787d0d3c2f72d) Thanks [@scuffi](https://github.com/scuffi)! - Add local R2 bucket mounting for development via bidirectional sync

## 0.7.17

### Patch Changes

- [#474](https://github.com/cloudflare/sandbox-sdk/pull/474) [`5b0ce89`](https://github.com/cloudflare/sandbox-sdk/commit/5b0ce89eedb63d9920eaf82046a12e3837e1b660) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add `gitignore` and `excludes` options to `createBackup()`.
  - `gitignore: true` excludes gitignored files when the directory is inside a git repo.
    If git is not installed, a warning is logged and the backup proceeds without git-based exclusions.
  - `excludes: string[]` allows explicit glob patterns to exclude from the backup.
  - Both default to off/empty — existing behavior is unchanged.

## 0.7.16

### Patch Changes

- [#470](https://github.com/cloudflare/sandbox-sdk/pull/470) [`887b032`](https://github.com/cloudflare/sandbox-sdk/commit/887b0321990a3e23f8060229ecc06210affb3f1c) Thanks [@maschwenk](https://github.com/maschwenk)! - Pass session env vars and working directory to PTY on creation

## 0.7.15

### Patch Changes

- [#400](https://github.com/cloudflare/sandbox-sdk/pull/400) [`92e1fda`](https://github.com/cloudflare/sandbox-sdk/commit/92e1fdabb5313b9c23a755cebb9f8807954ca346) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Improve idle timeout handling for long-running streams over WebSocket transport.

  Streams now remain open as long as data is flowing, timing out only after 5 minutes of inactivity.

- [#450](https://github.com/cloudflare/sandbox-sdk/pull/450) [`75dc1f9`](https://github.com/cloudflare/sandbox-sdk/commit/75dc1f9ae127479de782934d307c1acdbd2591d2) Thanks [@scuffi](https://github.com/scuffi)! - Support per-command and per-session timeouts for exec

  Timeouts now propagate correctly through the full stack. Per-command `timeout` on `exec()` takes priority over session-level `commandTimeoutMs` set via `createSession()`, which takes priority over the container-level `COMMAND_TIMEOUT_MS` environment variable.

## 0.7.14

### Patch Changes

- [#476](https://github.com/cloudflare/sandbox-sdk/pull/476) [`440eb1f`](https://github.com/cloudflare/sandbox-sdk/commit/440eb1fa929b8e57d69c055f256f9b9c40f2d36e) Thanks [@berry1001](https://github.com/berry1001)! - Fix sandboxes staying awake indefinitely after disabling `keepAlive`. Calling `setKeepAlive(false)` now correctly re-arms the `sleepAfter` timeout so the sandbox returns to its configured sleep lifecycle.

- [#469](https://github.com/cloudflare/sandbox-sdk/pull/469) [`856f4dd`](https://github.com/cloudflare/sandbox-sdk/commit/856f4dd80c853fe857f4ecb88c3dc52a3e0bf110) Thanks [@maschwenk](https://github.com/maschwenk)! - Add `shell` option to `PtyOptions` to allow specifying which shell to spawn (e.g. `zsh`, `sh`, `fish`). Defaults to `bash` when not specified.

## 0.7.13

### Patch Changes

- [#459](https://github.com/cloudflare/sandbox-sdk/pull/459) [`f3e264a`](https://github.com/cloudflare/sandbox-sdk/commit/f3e264ad6d74d50e7410703c9ac51e7f6f656496) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix four root causes of intermittent sandbox failures: a debounce deadlock in log pattern matching that caused startups to time out, incorrect HTTP 500 classification for transient startup errors that prevented retries, a WebSocket chunk race where streaming responses dropped data before the controller was ready, and missing timeout protection on git clone operations that could hang indefinitely on slow or unreachable remotes.

## 0.7.12

### Patch Changes

- [#452](https://github.com/cloudflare/sandbox-sdk/pull/452) [`5cce034`](https://github.com/cloudflare/sandbox-sdk/commit/5cce03430392fd47e4fb4bd011add5279d09db2e) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix crash when destroying a session that has an active streaming command. The stream now terminates cleanly instead of throwing a null pointer error.

- [#449](https://github.com/cloudflare/sandbox-sdk/pull/449) [`909e8c5`](https://github.com/cloudflare/sandbox-sdk/commit/909e8c55d257b76dac65dd22e76996a9f0622a23) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix sandbox creation timing out for large container images even when startup timeouts are configured to allow enough time. The transport retry budget now automatically scales to match configured startup timeouts instead of being hard-coded at 120 seconds.

## 0.7.11

### Patch Changes

- [#446](https://github.com/cloudflare/sandbox-sdk/pull/446) [`bbaba54`](https://github.com/cloudflare/sandbox-sdk/commit/bbaba5403e1bc7e062f36c37bfdd72e6683ff965) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix heredoc commands (e.g. `cat << 'EOF'`) hanging permanently and making the session unusable for subsequent commands.

- [#447](https://github.com/cloudflare/sandbox-sdk/pull/447) [`4088435`](https://github.com/cloudflare/sandbox-sdk/commit/4088435d9dc2ea8965518836d09b966dfe3ae661) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix three reliability issues: OpenCode readiness probe returning healthy before the binary is ready, file watch race condition where stale watchers could linger after cancellation, and SSE stream handler registering output listeners after replaying buffered logs — causing intermittent `waitForLog` timeouts on HTTP transport.

## 0.7.10

### Patch Changes

- [#422](https://github.com/cloudflare/sandbox-sdk/pull/422) [`dc70649`](https://github.com/cloudflare/sandbox-sdk/commit/dc706497a3e3014cbca3ab20f456e7f207798097) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add desktop environment support for AI computer-use workflows.

  Start a full Linux desktop (Xvfb + XFCE4 + x11vnc + noVNC) inside the
  sandbox and control it programmatically via `sandbox.desktop.*` methods.
  Supports screenshots, mouse clicks, keyboard input, and live browser
  streaming via noVNC preview URLs.

  Enable with `sandbox.desktop.start()`. Requires the desktop container
  image variant.

## 0.7.9

### Patch Changes

- [#324](https://github.com/cloudflare/sandbox-sdk/pull/324) [`2af3c28`](https://github.com/cloudflare/sandbox-sdk/commit/2af3c283334ff9317f28e36c0b63cbc1b302f5ce) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add real-time file watching for detecting filesystem changes as they happen.

  `sandbox.watch()` returns an SSE stream of create, modify, delete, and move events using native inotify. The stream can be proxied directly to a client or consumed server-side with `parseSSEStream`:

  ```typescript
  // Stream events to a browser client
  const stream = await sandbox.watch('/workspace/src', {
    recursive: true,
    include: ['*.ts', '*.js']
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });

  // Or consume server-side
  for await (const event of parseSSEStream<FileWatchSSEEvent>(stream)) {
    console.log(event.type, event.path);
  }
  ```

## 0.7.8

### Patch Changes

- [#427](https://github.com/cloudflare/sandbox-sdk/pull/427) [`04b4ccf`](https://github.com/cloudflare/sandbox-sdk/commit/04b4ccf5d6ff180d9e93ff582abd27b7f13ca36d) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix local development crash loops after Docker restarts or idle timeouts. The Sandbox now detects stale container state and automatically recovers.

## 0.7.7

### Patch Changes

- [#402](https://github.com/cloudflare/sandbox-sdk/pull/402) [`eb23055`](https://github.com/cloudflare/sandbox-sdk/commit/eb23055ca6d0cf8069628e60eb25290a2cfe90e4) Thanks [@scuffi](https://github.com/scuffi)! - Improve `readFile()` and `readFileStream()` performance by using native syscall file reads instead of shell-based reads.
  This increases read transfer speeds and unblocks the max throughput from file streaming.

  Improving file size handling: calls to `readFile()` now return a `413: File too large error` if the target file exceeds `32 MiB`. Previously such files would trigger a generic error; we're now explicit about the limitation and recommend using `readFileStream` for larger files.

- [#421](https://github.com/cloudflare/sandbox-sdk/pull/421) [`1244660`](https://github.com/cloudflare/sandbox-sdk/commit/1244660a2fdffa27361f98a998c402ffc36c1151) Thanks [@scuffi](https://github.com/scuffi)! - Patch `proxyToSandbox` to pass redirect responses to the caller, instead of following them

- [#430](https://github.com/cloudflare/sandbox-sdk/pull/430) [`364e366`](https://github.com/cloudflare/sandbox-sdk/commit/364e366e2cf15c9d71bd52fa8b7ac5ec93b82039) Thanks [@scuffi](https://github.com/scuffi)! - Patch `readFile` to strip MIME type parameters, e.g. `text/plain;charset=utf-8` -> `text/plain`

## 0.7.6

### Patch Changes

- [#417](https://github.com/cloudflare/sandbox-sdk/pull/417) [`9cbebd8`](https://github.com/cloudflare/sandbox-sdk/commit/9cbebd83ab00fec916216478371c4a6f08f65c2e) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Stream backup archive uploads to presigned R2 URLs with `curl -T` instead of `--data-binary`.
  This avoids large in-memory payload allocation and improves reliability for multi-GB backups.

- [#419](https://github.com/cloudflare/sandbox-sdk/pull/419) [`35f7d65`](https://github.com/cloudflare/sandbox-sdk/commit/35f7d6569ac8c99a9c78f8a1ebb18e122e74b385) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix flaky OpenCode E2E test by checking health endpoint readiness

  Changed `waitForPort` to verify `/global/health` returns HTTP 200 instead of just checking if the server accepts connections at `/`. This ensures the OpenCode server is fully initialized before `createOpencodeServer` returns, preventing 500 errors when tests immediately call the health endpoint.

- [#418](https://github.com/cloudflare/sandbox-sdk/pull/418) [`6994598`](https://github.com/cloudflare/sandbox-sdk/commit/6994598220fd5b2bdff23b774b25a01faf0966c6) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Improve error message when backup upload verification fails due to a local/remote R2 mismatch. When using `wrangler dev`, presigned URLs upload to real R2 while the `BACKUP_BUCKET` binding defaults to local storage. The error now suggests adding `"remote": true` to the R2 binding in `wrangler.jsonc`.

- [#404](https://github.com/cloudflare/sandbox-sdk/pull/404) [`c602785`](https://github.com/cloudflare/sandbox-sdk/commit/c602785b72d549abe0f60b106b1375b5eaa82e50) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Improve `writeFile()` performance by using native container file writes instead of shell-based write pipelines.
  This reduces write latency for both UTF-8 and base64 payloads while preserving existing encoding behavior.

- [#412](https://github.com/cloudflare/sandbox-sdk/pull/412) [`5abdb55`](https://github.com/cloudflare/sandbox-sdk/commit/5abdb5576e8f677741d597970d8f4d5afc2b4cef) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix file writes without an explicit `encoding` so requests use default write options instead of sending `encoding: undefined`.

## 0.7.5

### Patch Changes

- [#396](https://github.com/cloudflare/sandbox-sdk/pull/396) [`76284f0`](https://github.com/cloudflare/sandbox-sdk/commit/76284f02154056b89ce0861373d51966e3fe0f02) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add backup and restore API for directory snapshots.

  `createBackup()` archives a directory as a compressed squashfs image and uploads it to R2.
  `restoreBackup()` downloads and mounts the archive with copy-on-write semantics via FUSE overlay.

  Requires R2 presigned URL credentials: set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `CLOUDFLARE_ACCOUNT_ID`, and `BACKUP_BUCKET_NAME` as environment variables alongside the
  `BACKUP_BUCKET` R2 binding. Archives transfer directly between the container and R2
  at ~24 MB/s upload / ~93 MB/s download.

- [#403](https://github.com/cloudflare/sandbox-sdk/pull/403) [`bbfc579`](https://github.com/cloudflare/sandbox-sdk/commit/bbfc579645e53f9e1c6ba54760bfa3d249f6de1c) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add `proxyToOpencodeServer()` to proxy requests directly to a running OpenCode server without web UI redirect behavior. Use this helper for headless API and CLI traffic where raw request forwarding is preferred.

## 0.7.4

### Patch Changes

- [#393](https://github.com/cloudflare/sandbox-sdk/pull/393) [`76903ad`](https://github.com/cloudflare/sandbox-sdk/commit/76903ad968bc8fda5d319a56f9c900116c64234f) Thanks [@AshishKumar4](https://github.com/AshishKumar4)! - Fixes the bug where SDK's expected provider string 'cloudflareAIGateway' (camelCase) isn't recognised by opencode, and thus the opencode example fails to work with ai gateway.Also improved the example code with instructions for ai gateway via unified billing

## 0.7.3

### Patch Changes

- [#366](https://github.com/cloudflare/sandbox-sdk/pull/366) [`fa1713e`](https://github.com/cloudflare/sandbox-sdk/commit/fa1713e3dd162605405c0b3471e5e84c6ac56afe) Thanks [@kevoconnell](https://github.com/kevoconnell)! - Update the OpenCode integration to use the latest @opencode-ai/sdk (v2) client API. Install @opencode-ai/sdk@^1.1.40 to use OpenCode features.

- [#390](https://github.com/cloudflare/sandbox-sdk/pull/390) [`1817eaf`](https://github.com/cloudflare/sandbox-sdk/commit/1817eaf08bc8a9331f7d6ea93fa681b8b5b2e868) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix `fetch()` losing its `this` binding when called on the proxy returned by `getSandbox()`. This caused preview URL WebSocket routing to fail at runtime.

## 0.7.2

### Patch Changes

- [#383](https://github.com/cloudflare/sandbox-sdk/pull/383) [`0a4592f`](https://github.com/cloudflare/sandbox-sdk/commit/0a4592f8f66edab6c85ecb800ae9dad5e696c39b) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add Alpine-based musl image variant published as `cloudflare/sandbox:VERSION-musl`.

  A lightweight (51 MB) functional sandbox for Alpine and musl-based containers. Supports all core SDK methods (`exec`, file operations, git, port exposure, bucket mounting). Does not include Python or Node.js runtimes — add them with `apk add` to enable `runCode()`.

  As a base image:

  ```dockerfile
  FROM docker.io/cloudflare/sandbox:0.7.2-musl
  ```

  Or copy the binary into your own Alpine image:

  ```dockerfile
  COPY --from=docker.io/cloudflare/sandbox:0.7.2-musl /container-server/sandbox /sandbox
  ```

- [#377](https://github.com/cloudflare/sandbox-sdk/pull/377) [`d83642e`](https://github.com/cloudflare/sandbox-sdk/commit/d83642e855f68e4fb8c15c2452709923e55a83fd) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Allow port 8787 in `exposePort()`. It was incorrectly blocked.

## 0.7.1

### Patch Changes

- [#310](https://github.com/cloudflare/sandbox-sdk/pull/310) [`3c03587`](https://github.com/cloudflare/sandbox-sdk/commit/3c035872aee5c2481527d9d23e62c8f4b6818815) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add terminal support for browser-based terminal UIs.

  Build interactive terminal experiences by connecting xterm.js to container PTYs via WebSocket. Terminals reconnect automatically with output history preserved, and each session gets its own isolated terminal.

  ```typescript
  // Proxy WebSocket to container terminal
  return sandbox.terminal(request, { cols: 80, rows: 24 });

  // Multiple isolated terminals in the same sandbox
  const session = await sandbox.getSession('dev');
  return session.terminal(request);
  ```

  Also exports `@cloudflare/sandbox/xterm` with a `SandboxAddon` for xterm.js — handles WebSocket connection, reconnection with exponential backoff, and terminal resize forwarding.

  ```typescript
  import { SandboxAddon } from '@cloudflare/sandbox/xterm';

  const addon = new SandboxAddon({
    getWebSocketUrl: ({ sandboxId, origin }) =>
      `${origin}/ws/terminal?id=${sandboxId}`
  });
  terminal.loadAddon(addon);
  addon.connect({ sandboxId: 'my-sandbox' });
  ```

## 0.7.0

### Minor Changes

- [#329](https://github.com/cloudflare/sandbox-sdk/pull/329) [`fc1a8ea`](https://github.com/cloudflare/sandbox-sdk/commit/fc1a8ea29cd1fe872ce1c08eabca083601aae5c3) Thanks [@mikenomitch](https://github.com/mikenomitch)! - Add support for custom tokens in `exposePort()` to enable stable preview URLs across deployments.

  You can now pass a custom token when exposing ports to maintain consistent preview URLs between container restarts and deployments. This is useful for sharing URLs with users or maintaining stable references in production environments.

  ```typescript
  // With custom token - URL stays the same across restarts
  const { url } = await sandbox.exposePort(8080, {
    hostname: 'example.com',
    token: 'my_token_v1' // 1-16 chars: a-z, 0-9, _
  });
  // url: https://8080-sandbox-id-my-token-v1.example.com

  // Without token - generates random 16-char token (existing behavior)
  const { url } = await sandbox.exposePort(8080, {
    hostname: 'example.com'
  });
  // url: https://8080-sandbox-id-abc123random4567.example.com
  ```

  Custom tokens must be 1-16 characters containing only lowercase letters, numbers, and underscores.

  **Breaking change:** Tokens can no longer contain hyphens. Existing preview URLs with hyphenated tokens (including some auto-generated ones) will stop working until the port is re-exposed.

### Patch Changes

- [#347](https://github.com/cloudflare/sandbox-sdk/pull/347) [`efdd0d7`](https://github.com/cloudflare/sandbox-sdk/commit/efdd0d779a8a225da5c26c5ac53011a37ab24315) Thanks [@roerohan](https://github.com/roerohan)! - Add Cloudflare AI Gateway support to OpenCode integration. Users can now route AI provider requests through Cloudflare AI Gateway for monitoring, caching, and rate limiting by adding a `cloudflareAIGateway` provider configuration with `accountId`, `gatewayId`, and optional `apiToken`.

- [#342](https://github.com/cloudflare/sandbox-sdk/pull/342) [`7da85c0`](https://github.com/cloudflare/sandbox-sdk/commit/7da85c069543847633c32cedc0ef8329bf31478e) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Handle undefined environment variables as "unset" in setEnvVars

  Environment variable APIs now properly handle undefined values:
  - String values are exported as before
  - undefined/null values now **unset** the variable (runs `unset VAR`)

  This enables idiomatic JavaScript patterns:

  ```typescript
  await sandbox.setEnvVars({
    API_KEY: 'new-key',
    OLD_SECRET: undefined // unsets OLD_SECRET
  });
  ```

  **Before**: `sandbox.setEnvVars({ KEY: undefined })` threw a runtime error
  **After**: `sandbox.setEnvVars({ KEY: undefined })` runs `unset KEY`

  TypeScript types now honestly accept `Record<string, string | undefined>`.

## 0.6.11

### Patch Changes

- [#335](https://github.com/cloudflare/sandbox-sdk/pull/335) [`0d2e199`](https://github.com/cloudflare/sandbox-sdk/commit/0d2e199dba9c3a5bc384b27d50e614fcb3311681) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Mount subdirectories of S3 buckets using the `prefix` option in `mountBucket()`.

## 0.6.10

### Patch Changes

- [#326](https://github.com/cloudflare/sandbox-sdk/pull/326) [`9344a4d`](https://github.com/cloudflare/sandbox-sdk/commit/9344a4dc0d9daa3cf9435c29f391da164b393455) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add shallow clone support via `depth` option in `gitCheckout()`. Use `depth: 1` to clone only the latest commit, reducing clone time and disk usage for large repositories.

## 0.6.9

### Patch Changes

- [#323](https://github.com/cloudflare/sandbox-sdk/pull/323) [`274ee4c`](https://github.com/cloudflare/sandbox-sdk/commit/274ee4cdb589cd34995539221a3445836cbe062f) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix sleepAfter option passed to getSandbox() being ignored.

  The custom sleepAfter timeout value is now correctly applied when specified in getSandbox() options.

## 0.6.8

### Patch Changes

- [#317](https://github.com/cloudflare/sandbox-sdk/pull/317) [`9e1d8f5`](https://github.com/cloudflare/sandbox-sdk/commit/9e1d8f50c95877e25ae6080d574a3683bbb0588e) Thanks [@sdan](https://github.com/sdan)! - fix: persist keepAlive setting to DO storage

## 0.6.7

### Patch Changes

- [#305](https://github.com/cloudflare/sandbox-sdk/pull/305) [`f2544c1`](https://github.com/cloudflare/sandbox-sdk/commit/f2544c1f66408b85ed10b69c8eb964bf1a02ed0c) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Replace HTTP polling with SSE streaming for waitForPort.
  This reduces container log noise and eliminates repeated HTTP requests during port readiness checks.

- [#253](https://github.com/cloudflare/sandbox-sdk/pull/253) [`4b4ab48`](https://github.com/cloudflare/sandbox-sdk/commit/4b4ab483345ed3ffbd716a1ba4dcdb7df51fbd9c) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Add WebSocket transport to avoid sub-request limits in Workers and Durable Objects. Set `SANDBOX_TRANSPORT=websocket` environment variable to multiplex all SDK calls over a single persistent connection.

## 0.6.6

### Patch Changes

- [#299](https://github.com/cloudflare/sandbox-sdk/pull/299) [`d3252dc`](https://github.com/cloudflare/sandbox-sdk/commit/d3252dc9ef8f5c8ce23011c2a8492c6f248f92f2) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add waitForExit() method to Process interface for waiting until a process terminates

- [#296](https://github.com/cloudflare/sandbox-sdk/pull/296) [`8a5d275`](https://github.com/cloudflare/sandbox-sdk/commit/8a5d275b0ccd341cd352a42c2659e56c6b841212) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix race condition for PID retrieval

- [`a86f7db`](https://github.com/cloudflare/sandbox-sdk/commit/a86f7db01a4d8c4abf9843bfc1aef8841a775d70) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Improve automatic retry behavior for container startup errors

  Transient errors like "container starting" now automatically retry with exponential backoff, while permanent errors like "missing image" fail immediately with clear error messages.

## 0.6.5

### Patch Changes

- [#290](https://github.com/cloudflare/sandbox-sdk/pull/290) [`2322c80`](https://github.com/cloudflare/sandbox-sdk/commit/2322c806fccc9c598e97dc337cc7e2db7ffbc9d2) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add per-session mutex locking to prevent concurrent command execution race conditions

- [#280](https://github.com/cloudflare/sandbox-sdk/pull/280) [`5d87b35`](https://github.com/cloudflare/sandbox-sdk/commit/5d87b351fa554a32cf7a274b497d43f041cc9c1a) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add standalone binary support for arbitrary Dockerfiles

  Users can now add sandbox capabilities to any Docker image:

  ```dockerfile
  FROM your-image:tag

  COPY --from=cloudflare/sandbox:VERSION /container-server/sandbox /sandbox
  ENTRYPOINT ["/sandbox"]

  # Optional: run your own startup command
  CMD ["/your-entrypoint.sh"]
  ```

  The `/sandbox` binary starts the HTTP API server, then executes any CMD as a child process with signal forwarding.

  Includes backwards compatibility for existing custom startup scripts.

## 0.6.4

### Patch Changes

- [#282](https://github.com/cloudflare/sandbox-sdk/pull/282) [`d3997a8`](https://github.com/cloudflare/sandbox-sdk/commit/d3997a8b9a443b5726d780bff2d3f4530db3e53b) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add OpenCode integration with createOpencode() and proxyToOpencode() helpers

- [#286](https://github.com/cloudflare/sandbox-sdk/pull/286) [`c6349aa`](https://github.com/cloudflare/sandbox-sdk/commit/c6349aa274d8c9e226f1782320c82d416393634d) Thanks [@NuroDev](https://github.com/NuroDev)! - Fix `options` parameter types for `gitCheckout`

- [#281](https://github.com/cloudflare/sandbox-sdk/pull/281) [`472d5ae`](https://github.com/cloudflare/sandbox-sdk/commit/472d5ae4bb7fbf075376a90558a2de282c649edb) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix session initialization to eliminate noisy error logs during hot reloads

- [#289](https://github.com/cloudflare/sandbox-sdk/pull/289) [`67100d0`](https://github.com/cloudflare/sandbox-sdk/commit/67100d070cc8608ccb8da8845ddb9bfafc109d72) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix workspace bug

## 0.6.3

### Patch Changes

- [#273](https://github.com/cloudflare/sandbox-sdk/pull/273) [`8cf6b2f`](https://github.com/cloudflare/sandbox-sdk/commit/8cf6b2fe5b7aa0d9287387067a0a2f26ef538de4) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add process readiness detection with port and log pattern waiting
  The `Process` object returned by `startProcess()` now includes readiness methods:
  - `process.waitForPort(port, options?)`: Wait for process to listen on a port
    - Supports HTTP mode (default): checks endpoint returns expected status (200-399)
    - Supports TCP mode: checks port accepts connections
    - Configurable timeout, interval, path, and expected status
  - `process.waitForLog(pattern, options?)`: Wait for pattern in process output
    - Supports string or RegExp patterns
    - Returns matching line and capture groups

## 0.6.2

### Patch Changes

- [#267](https://github.com/cloudflare/sandbox-sdk/pull/267) [`204f9ac`](https://github.com/cloudflare/sandbox-sdk/commit/204f9ac301c983ed04589eb9d72418a0b06ec8a3) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix process callbacks, PID capture, and getLogs race condition for fast commands

- [#264](https://github.com/cloudflare/sandbox-sdk/pull/264) [`8601b5c`](https://github.com/cloudflare/sandbox-sdk/commit/8601b5c4fcb3a822aeefd870f26b3618c59e3212) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix type error when extending Sandbox class by making getSandbox and SandboxEnv generic

- [#263](https://github.com/cloudflare/sandbox-sdk/pull/263) [`059963e`](https://github.com/cloudflare/sandbox-sdk/commit/059963e80ff7d7d9696e8d9770339d3e849fcfdf) Thanks [@PavanKalisetti](https://github.com/PavanKalisetti)! - Fix a bug where the /api/ping endpoint was not handled, causing a 500 error

## 0.6.1

### Patch Changes

- [#261](https://github.com/cloudflare/sandbox-sdk/pull/261) [`b6cc244`](https://github.com/cloudflare/sandbox-sdk/commit/b6cc24456681932b76d17dd57b6e788c18813cc4) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add top-level await support for JavaScript code execution

  JavaScript code can now use `await` at the top level without wrapping in an async IIFE. Variables declared with `const`, `let`, or `var` persist across executions, enabling multi-step workflows like:

  ```javascript
  // Execution 1
  const data = await fetch('https://api.example.com').then((r) => r.json());

  // Execution 2
  console.log(data); // Works - data persists
  ```

## 0.6.0

### Minor Changes

- [#259](https://github.com/cloudflare/sandbox-sdk/pull/259) [`0a2cb93`](https://github.com/cloudflare/sandbox-sdk/commit/0a2cb931c7f02f119816478d972fe437092a2010) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add lean and Python image variants to reduce Docker image size

  **BREAKING CHANGE for Python users:** The default image no longer includes Python.
  - `cloudflare/sandbox:<version>` - lean image without Python (~600-800MB)
  - `cloudflare/sandbox:<version>-python` - full image with Python + data science packages (~1.3GB)

  **Migration:** If using `CodeInterpreter.runCode()` with Python, update your Dockerfile:

  ```dockerfile
  # Before
  FROM cloudflare/sandbox:0.6.0

  # After
  FROM cloudflare/sandbox:0.6.0-python
  ```

  Without this change, Python execution will fail with `PYTHON_NOT_AVAILABLE` error.

## 0.5.6

### Patch Changes

- [#249](https://github.com/cloudflare/sandbox-sdk/pull/249) [`e69dce5`](https://github.com/cloudflare/sandbox-sdk/commit/e69dce54e76b5e0597e0f4ebb798c933543349a7) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix code context isolation bug where contexts leaked state after 10 executions. Each code context now gets a dedicated executor process from creation to deletion, ensuring complete isolation between contexts. Removed maximum pool size limits to allow organic scaling.

- [#258](https://github.com/cloudflare/sandbox-sdk/pull/258) [`34bfb81`](https://github.com/cloudflare/sandbox-sdk/commit/34bfb81e7d7f96d6e2f62bb43330a6e675c2c54c) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix executor mutex race condition and memory leak in code interpreter

- [#256](https://github.com/cloudflare/sandbox-sdk/pull/256) [`088ee5f`](https://github.com/cloudflare/sandbox-sdk/commit/088ee5fceae50f2338011b5c7560e056bdf6e48a) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Remove output size limit for command execution

  The 10MB output size limit that was intended to prevent OOM attacks has been removed. This limit was too restrictive for legitimate use cases like reading large media files. Developers are now trusted to manage their own resource usage and handle potential OOM situations.

- [#254](https://github.com/cloudflare/sandbox-sdk/pull/254) [`8728890`](https://github.com/cloudflare/sandbox-sdk/commit/872889064f7ce59d49bc12bdf151df94cfe1efe4) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - close stream before releasing lock

## 0.5.5

### Patch Changes

- [#245](https://github.com/cloudflare/sandbox-sdk/pull/245) [`ecaafa9`](https://github.com/cloudflare/sandbox-sdk/commit/ecaafa9c4e213bf955a464d0c977830956a77336) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Publish Docker images for linux/amd64 only to ensure dev/prod parity. ARM Mac users will automatically use emulation, matching production deployment behavior. This prevents architecture-specific bugs caused by Docker automatically selecting ARM64 variants on ARM hosts.

- [#251](https://github.com/cloudflare/sandbox-sdk/pull/251) [`ba83581`](https://github.com/cloudflare/sandbox-sdk/commit/ba83581a9c8eff6f6bf5913baf2c9186729126a4) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

## 0.5.4

### Patch Changes

- [#243](https://github.com/cloudflare/sandbox-sdk/pull/243) [`32a0dab`](https://github.com/cloudflare/sandbox-sdk/commit/32a0dab89375aa238a97b9d213234236fd364195) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add getFileMetadata method in FileService to get only metadata

## 0.5.3

### Patch Changes

- [#204](https://github.com/cloudflare/sandbox-sdk/pull/204) [`55981f8`](https://github.com/cloudflare/sandbox-sdk/commit/55981f8802b4e0d3b65b947ef8ba7ae2bae183d7) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add environment variables and working directory support to command exec

## 0.5.2

### Patch Changes

- [#234](https://github.com/cloudflare/sandbox-sdk/pull/234) [`d4cee5e`](https://github.com/cloudflare/sandbox-sdk/commit/d4cee5e4617db205c9c1ca714e25493de7ea24ce) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Remove unused logging infrastructure (getLogger, runWithLogger) that was never called

- [#224](https://github.com/cloudflare/sandbox-sdk/pull/224) [`71e86f4`](https://github.com/cloudflare/sandbox-sdk/commit/71e86f42c3b98424db79c268d55f2d5be5e495b3) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix memory leaks from listener accumulation, unbounded process storage, and stale DO state

- [#221](https://github.com/cloudflare/sandbox-sdk/pull/221) [`3aba9e8`](https://github.com/cloudflare/sandbox-sdk/commit/3aba9e8da6e2e6acd7b40076cc0920a69cb02775) Thanks [@threepointone](https://github.com/threepointone)! - Add OpenAI Agents adapters

  Add OpenAI Agents adapters (`Shell` and `Editor`) that integrate Cloudflare Sandbox with the OpenAI Agents SDK. These adapters enable AI agents to execute shell commands and perform file operations (create, update, delete) inside sandboxed environments. Both adapters automatically collect and timestamp results from operations, making it easy to track command execution and file modifications during agent sessions. The adapters are exported from `@cloudflare/sandbox/openai` and implement the OpenAI Agents `Shell` and `Editor` interfaces.

## 0.5.1

### Patch Changes

- [#190](https://github.com/cloudflare/sandbox-sdk/pull/190) [`57d764c`](https://github.com/cloudflare/sandbox-sdk/commit/57d764c2f01ca3ed93fd3d3244a50e8262405e1b) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add S3-compatible bucket mounting

  Enable mounting S3-compatible buckets (R2, S3, GCS, MinIO, etc.) as local filesystem paths using s3fs-fuse. Supports automatic credential detection from environment variables and intelligent provider detection from endpoint URLs.

- [#223](https://github.com/cloudflare/sandbox-sdk/pull/223) [`b1a86c8`](https://github.com/cloudflare/sandbox-sdk/commit/b1a86c89285ebcae36ee9bb2f68f7765265e4504) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Improve container startup resiliency

  SDK now retries both 503 (provisioning) and 500 (startup failure) errors automatically. Container timeouts increased to 30s instance + 90s ports (was 8s + 20s).

- [#219](https://github.com/cloudflare/sandbox-sdk/pull/219) [`94e53f8`](https://github.com/cloudflare/sandbox-sdk/commit/94e53f80daf746148b7c0c83b27e256637b935c2) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

## 0.5.0

### Minor Changes

- [#213](https://github.com/cloudflare/sandbox-sdk/pull/213) [`8503265`](https://github.com/cloudflare/sandbox-sdk/commit/8503265d2491a1f8e1fc1ab2f9cf7f9f0baef34b) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add opt-in `normalizeId` option to `getSandbox()` for preview URL compatibility.

  Sandbox IDs with uppercase letters cause preview URL requests to route to different Durable Object instances (hostnames are case-insensitive). Use `{ normalizeId: true }` to lowercase IDs for preview URL support:

  ```typescript
  getSandbox(ns, 'MyProject-123', { normalizeId: true }); // Creates DO with key "myproject-123"
  ```

  **Important:** Different `normalizeId` values create different DO instances. If you have an existing sandbox with uppercase letters, create a new one with `normalizeId: true`.

  **Deprecation warning:** IDs with uppercase letters will trigger a warning. In a future version, `normalizeId` will default to `true`.

## 0.4.21

### Patch Changes

- [#214](https://github.com/cloudflare/sandbox-sdk/pull/214) [`102fc4f`](https://github.com/cloudflare/sandbox-sdk/commit/102fc4fdfddac98189610334de6ca096153e2fe8) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix Docker build failures caused by turbo prune lockfile mismatch

  Remove @cloudflare/vite-plugin from root devDependencies to avoid turbo prune bug with nested optionalDependencies. The vite-plugin is only used by examples which are excluded from Docker builds and already have it in their own package.json.

## 0.4.20

### Patch Changes

- [#208](https://github.com/cloudflare/sandbox-sdk/pull/208) [`d4bb3b7`](https://github.com/cloudflare/sandbox-sdk/commit/d4bb3b782db458f81c2c0b9148ac4b4fb65eca9f) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add Apache License 2.0

  Formalizes project licensing under Apache 2.0 for consistency with Cloudflare's platform projects. Previous versions (0.1.0-0.4.18) had ambiguous licensing (ISC in package.json, MIT referenced in README, no LICENSE file).

## 0.4.19

### Patch Changes

- [#203](https://github.com/cloudflare/sandbox-sdk/pull/203) [`63b07c0`](https://github.com/cloudflare/sandbox-sdk/commit/63b07c0895f3cb9bf44fc84df1b5671b27391152) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix listFiles to work in hidden directories without includeHidden flag

## 0.4.18

### Patch Changes

- [`228ef5b`](https://github.com/cloudflare/sandbox-sdk/commit/228ef5b6e57fa3c38dc8d90e006ae58d0815aaec) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix encoding parameter handling in file operations to enable MIME auto-detection. Previously, SDK and container handlers added default 'utf8' encoding, preventing MIME-based detection of binary files. Now encoding parameter is passed through as-is, allowing automatic detection when not explicitly specified.

## 0.4.17

### Patch Changes

- [#198](https://github.com/cloudflare/sandbox-sdk/pull/198) [`93c6cc7`](https://github.com/cloudflare/sandbox-sdk/commit/93c6cc7c6b8df9e0a733fa852faf5d2f1c5758da) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix container startup failures when WORKDIR is changed in derived Dockerfiles

## 0.4.16

### Patch Changes

- [#184](https://github.com/cloudflare/sandbox-sdk/pull/184) [`7989b61`](https://github.com/cloudflare/sandbox-sdk/commit/7989b6105cea8c381dd162be0bcb29db3e214fde) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Redact credentials from Git URLs in logs

- [#186](https://github.com/cloudflare/sandbox-sdk/pull/186) [`c2e3384`](https://github.com/cloudflare/sandbox-sdk/commit/c2e3384b151ae3f430c2edc8c492921d0b6b8b1c) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Expose deleteSession API with proper safeguards
  - Add `deleteSession(sessionId)` method to public SDK API
  - Prevent deletion of default session (throws error with guidance to use `sandbox.destroy()`)
  - Session cleanup kills all running commands in parallel before destroying shell
  - Return structured `SessionDeleteResult` with success status, sessionId, and timestamp

## 0.4.15

### Patch Changes

- [#185](https://github.com/cloudflare/sandbox-sdk/pull/185) [`7897cdd`](https://github.com/cloudflare/sandbox-sdk/commit/7897cddefc366bbd640ea138b34a520a0b2ddf8c) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix foreground commands blocking on background processes

- [#183](https://github.com/cloudflare/sandbox-sdk/pull/183) [`ff2fa91`](https://github.com/cloudflare/sandbox-sdk/commit/ff2fa91479357ef88cfb22418f88acb257462faa) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - update python to 3.11.14

## 0.4.14

### Patch Changes

- [#172](https://github.com/cloudflare/sandbox-sdk/pull/172) [`1bf3576`](https://github.com/cloudflare/sandbox-sdk/commit/1bf35768b02532c77df6f30a2f2eb08cb2b12115) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#176](https://github.com/cloudflare/sandbox-sdk/pull/176) [`7edbfa9`](https://github.com/cloudflare/sandbox-sdk/commit/7edbfa906668d75f540527f50b52483dc787192c) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add cache mounts to Dockerfile for faster builds

  Adds cache mounts for npm, apt, and pip package managers in the Dockerfile. This speeds up Docker image builds when dependencies change, particularly beneficial for users building from source.

- [#172](https://github.com/cloudflare/sandbox-sdk/pull/172) [`1bf3576`](https://github.com/cloudflare/sandbox-sdk/commit/1bf35768b02532c77df6f30a2f2eb08cb2b12115) Thanks [@threepointone](https://github.com/threepointone)! - Fix type generation

  We inline types from `@repo/shared` so that it includes the types we reexport. Fixes #165

- [#175](https://github.com/cloudflare/sandbox-sdk/pull/175) [`77cb937`](https://github.com/cloudflare/sandbox-sdk/commit/77cb93762a619523758f769a10509e665ca819fe) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Move .connect to .wsConnect within DO stub

## 0.4.13

### Patch Changes

- [#168](https://github.com/cloudflare/sandbox-sdk/pull/168) [`6b08f02`](https://github.com/cloudflare/sandbox-sdk/commit/6b08f02c061aef07cc98188abef2973ac92365f8) Thanks [@threepointone](https://github.com/threepointone)! - Fix type generation

  We inline types from `@repo/shared` so that it includes the types we reexport. Fixes #165

- [#162](https://github.com/cloudflare/sandbox-sdk/pull/162) [`c4db459`](https://github.com/cloudflare/sandbox-sdk/commit/c4db459389a7b86048a03410d67d4dd7bf4a6085) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add WebSocket support via connect() method for routing client WebSocket connections directly to container services

## 0.4.12

### Patch Changes

- [#137](https://github.com/cloudflare/sandbox-sdk/pull/137) [`7f4442b`](https://github.com/cloudflare/sandbox-sdk/commit/7f4442b7a097587d8f8e8f9ff2f887df6943a3db) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add keepAlive flag to prevent containers from shutting down

## 0.4.11

### Patch Changes

- [#159](https://github.com/cloudflare/sandbox-sdk/pull/159) [`e16659a`](https://github.com/cloudflare/sandbox-sdk/commit/e16659a1815923f1cd1176f51a052725d820ee16) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Use latest containers package version

## 0.4.10

### Patch Changes

- [#156](https://github.com/cloudflare/sandbox-sdk/pull/156) [`b61841c`](https://github.com/cloudflare/sandbox-sdk/commit/b61841cfb3248022ee8136311e54955ed9faa1ee) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix WebSocket upgrade requests through exposed ports

## 0.4.9

### Patch Changes

- [#152](https://github.com/cloudflare/sandbox-sdk/pull/152) [`8e7773e`](https://github.com/cloudflare/sandbox-sdk/commit/8e7773ec9571a5f968cbbc5f48e38e01d7d13b77) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add exists() method to check if a file or directory exists

  This adds a new `exists()` method to the SDK that checks whether a file or directory exists at a given path. The method returns a boolean indicating existence, similar to Python's `os.path.exists()` and JavaScript's `fs.existsSync()`.

  The implementation is end-to-end:
  - New `FileExistsResult` and `FileExistsRequest` types in shared package
  - Handler endpoint at `/api/exists` in container layer
  - Client method in `FileClient` and `Sandbox` classes
  - Full test coverage (unit tests and E2E tests)

## 0.4.8

### Patch Changes

- [#153](https://github.com/cloudflare/sandbox-sdk/pull/153) [`f6a5c3e`](https://github.com/cloudflare/sandbox-sdk/commit/f6a5c3e1607fce5fc26f816e9206ae437898d5af) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix token extraction regex causing Invalid token errors

## 0.4.7

### Patch Changes

- [#141](https://github.com/cloudflare/sandbox-sdk/pull/141) [`c39674b`](https://github.com/cloudflare/sandbox-sdk/commit/c39674b8fe2e986e59a794b6bb3a5f51a87bae89) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix commands hanging when reading stdin by redirecting stdin to /dev/null

- [#143](https://github.com/cloudflare/sandbox-sdk/pull/143) [`276efc0`](https://github.com/cloudflare/sandbox-sdk/commit/276efc0ca8776bcc8de79e7e58dd24d9f418cc5c) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Remove unnecessary existing session check

## 0.4.6

### Patch Changes

- [#133](https://github.com/cloudflare/sandbox-sdk/pull/133) [`da2cfb8`](https://github.com/cloudflare/sandbox-sdk/commit/da2cfb876675eb3445970c90b4d70d00288a7c74) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - feat: Add version sync detection between npm package and Docker image

## 0.4.5

### Patch Changes

- [#127](https://github.com/cloudflare/sandbox-sdk/pull/127) [`e79ac80`](https://github.com/cloudflare/sandbox-sdk/commit/e79ac80bc855a3ec527d44cc14585794b23cb129) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - configurable sleepAfter

## 0.4.4

### Patch Changes

- [#125](https://github.com/cloudflare/sandbox-sdk/pull/125) [`fddccfd`](https://github.com/cloudflare/sandbox-sdk/commit/fddccfdce8204ce2aa7dadc0ad9fb2acbdeaec51) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add docker image to pkg workflow

## 0.4.3

### Patch Changes

- [#114](https://github.com/cloudflare/sandbox-sdk/pull/114) [`8c1f440`](https://github.com/cloudflare/sandbox-sdk/commit/8c1f440ad6fd89a5c69f9ca9d055ad9b183dd1c3) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Debloat base docker image (2.63GB → 1.03GB)

## 0.4.2

### Patch Changes

- [`e53d7e7`](https://github.com/cloudflare/sandbox-sdk/commit/e53d7e7ce185f79bdd899029bb532e9651ae7ba5) Thanks [@threepointone](https://github.com/threepointone)! - fix build by inlining repo/shared

## 0.4.1

### Patch Changes

- [#111](https://github.com/cloudflare/sandbox-sdk/pull/111) [`1b5496b`](https://github.com/cloudflare/sandbox-sdk/commit/1b5496bfceaee53c31911b409476ea87bebffe4c) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.4.0

### Minor Changes

- [#95](https://github.com/cloudflare/sandbox-sdk/pull/95) [`7aee736`](https://github.com/cloudflare/sandbox-sdk/commit/7aee736bf07a4bf9020e2109bdaaa70214d52a01) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Rewrite SDK with cleaner design patterns and tests. Remove the unnecessary isolation cruft and fix foundational issues with streaming, sessions, validations and error handling. Cover the SDK with unit & e2e tests.

### Patch Changes

- [#106](https://github.com/cloudflare/sandbox-sdk/pull/106) [`da947cd`](https://github.com/cloudflare/sandbox-sdk/commit/da947cd9543fc99831eefb1e8741fc905cb8fa42) Thanks [@jahands](https://github.com/jahands)! - fix examples failing to deploy and prevent committing node_modules

## 0.3.3

### Patch Changes

- [#83](https://github.com/cloudflare/sandbox-sdk/pull/83) [`eec5bb6`](https://github.com/cloudflare/sandbox-sdk/commit/eec5bb6203dd5d775b4b54e91c26de25eeb767ce) Thanks [@mikenomitch](https://github.com/mikenomitch)! - Bump containers package version

## 0.3.2

### Patch Changes

- [#76](https://github.com/cloudflare/sandbox-sdk/pull/76) [`ef9e320`](https://github.com/cloudflare/sandbox-sdk/commit/ef9e320dcef30e57797fef6ebd9a9383fa9720d9) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Replace Jupyter with lightweight interpreters for >90% faster cold starts for `.runCode` calls, while maintaining full code execution capabilities and rich output support.

## 0.3.1

### Patch Changes

- [#71](https://github.com/cloudflare/sandbox-sdk/pull/71) [`fb3c9c2`](https://github.com/cloudflare/sandbox-sdk/commit/fb3c9c22242d9d4f157c26f547f1e697ef7875f9) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Bump containers package version

- [#70](https://github.com/cloudflare/sandbox-sdk/pull/70) [`e1fa354`](https://github.com/cloudflare/sandbox-sdk/commit/e1fa354ab1bc7b0e89db4901b67028ebf1a93d0a) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix escaped quotes in file write operations

- [#68](https://github.com/cloudflare/sandbox-sdk/pull/68) [`69b91d1`](https://github.com/cloudflare/sandbox-sdk/commit/69b91d1a8f6afb63262cc381ea93e94a033ed5e8) Thanks [@CyrusNuevoDia](https://github.com/CyrusNuevoDia)! - Configurable timeouts via environment variables in isolation.ts

- [#66](https://github.com/cloudflare/sandbox-sdk/pull/66) [`eca93b9`](https://github.com/cloudflare/sandbox-sdk/commit/eca93b97e40fa0d3bd9dc27af2cc214ec355b696) Thanks [@peterp](https://github.com/peterp)! - Determine if the port is specified in the URL.

## 0.3.0

### Minor Changes

- [#59](https://github.com/cloudflare/sandbox-sdk/pull/59) [`b6757f7`](https://github.com/cloudflare/sandbox-sdk/commit/b6757f730c34381d5a70d513944bbf9840f598ab) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add process isolation for sandbox commands

  Implements PID namespace isolation to protect control plane processes (Jupyter, Bun) from sandboxed code. Commands executed via `exec()` now run in isolated namespaces that cannot see or interact with system processes.

  **Key security improvements:**
  - Control plane processes are hidden from sandboxed commands
  - Platform secrets in `/proc/1/environ` are inaccessible
  - Ports 8888 (Jupyter) and 3000 (Bun) are protected from hijacking

  **Breaking changes:**
  1. **Removed `sessionId` parameter**: The `sessionId` parameter has been removed from all methods (`exec()`, `execStream()`, `startProcess()`, etc.). Each sandbox now maintains its own persistent session automatically.

     ```javascript
     // Before: manual session management
     await sandbox.exec('cd /app', { sessionId: 'my-session' });

     // After: automatic session per sandbox
     await sandbox.exec('cd /app');
     ```

  2. **Commands now maintain state**: Commands within the same sandbox now share state (working directory, environment variables, background processes). Previously each command was stateless.

     ```javascript
     // Before: each exec was independent
     await sandbox.exec('cd /app');
     await sandbox.exec('pwd'); // Output: /workspace

     // After: state persists in session
     await sandbox.exec('cd /app');
     await sandbox.exec('pwd'); // Output: /app
     ```

  **Migration guide:**
  - Remove `sessionId` from all method calls - each sandbox maintains its own session
  - If you need isolated execution contexts within the same sandbox, use `sandbox.createSession()`:
    ```javascript
    // Create independent sessions with different environments
    const buildSession = await sandbox.createSession({
      name: 'build',
      env: { NODE_ENV: 'production' },
      cwd: '/build'
    });
    const testSession = await sandbox.createSession({
      name: 'test',
      env: { NODE_ENV: 'test' },
      cwd: '/test'
    });
    ```
  - Environment variables set in one command persist to the next
  - Background processes remain active until explicitly killed
  - Requires CAP_SYS_ADMIN (available in production, falls back gracefully in dev)

### Patch Changes

- [#62](https://github.com/cloudflare/sandbox-sdk/pull/62) [`4bedc3a`](https://github.com/cloudflare/sandbox-sdk/commit/4bedc3aba347f3d4090a6efe2c9778bac00ce74a) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix broken build due to bun lockfile not being used

## 0.2.4

### Patch Changes

- [#57](https://github.com/cloudflare/sandbox-sdk/pull/57) [`12bbd12`](https://github.com/cloudflare/sandbox-sdk/commit/12bbd1229c07ef8c1c0bf58a4235a27938155b08) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Add listFiles method

## 0.2.3

### Patch Changes

- [#53](https://github.com/cloudflare/sandbox-sdk/pull/53) [`c87db11`](https://github.com/cloudflare/sandbox-sdk/commit/c87db117693a86cfb667bf09fb7720d6a6e0524d) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Improve jupyterlab config to speed up startup

## 0.2.2

### Patch Changes

- [#51](https://github.com/cloudflare/sandbox-sdk/pull/51) [`4aceb32`](https://github.com/cloudflare/sandbox-sdk/commit/4aceb3215c836f59afcb88b2b325016b3f623f46) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Handle intermittent interpreter failures and decouple jupyter startup

## 0.2.1

### Patch Changes

- [#49](https://github.com/cloudflare/sandbox-sdk/pull/49) [`d81d2a5`](https://github.com/cloudflare/sandbox-sdk/commit/d81d2a563c9af8947d5444019ed4d6156db563e3) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Implement code interpreter API

## 0.2.0

### Minor Changes

- [#47](https://github.com/cloudflare/sandbox-sdk/pull/47) [`8a93d0c`](https://github.com/cloudflare/sandbox-sdk/commit/8a93d0cae18a25bda6506b8b0a08d9e9eb3bb290) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Change default directory to a clean /workspace

## 0.1.4

### Patch Changes

- [#46](https://github.com/cloudflare/sandbox-sdk/pull/46) [`7de28be`](https://github.com/cloudflare/sandbox-sdk/commit/7de28be482d9634551572d548c7c4b5842df812d) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Update README

- [#44](https://github.com/cloudflare/sandbox-sdk/pull/44) [`215ab49`](https://github.com/cloudflare/sandbox-sdk/commit/215ab494427d7e2a92bb9a25384cb493a221c200) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Update example to use env & cwd

- [#42](https://github.com/cloudflare/sandbox-sdk/pull/42) [`bb72193`](https://github.com/cloudflare/sandbox-sdk/commit/bb72193ad75695979bd1132206f481e91fe37325) Thanks [@jonasnobile](https://github.com/jonasnobile)! - Propagate `cwd` and `env` options in `executeCommand`

- [#27](https://github.com/cloudflare/sandbox-sdk/pull/27) [`fd5ec7f`](https://github.com/cloudflare/sandbox-sdk/commit/fd5ec7f34bc12b06320a89356c4af07801f52d64) Thanks [@threepointone](https://github.com/threepointone)! - remove yarn and pnpm from the image

## 0.1.3

### Patch Changes

- [#32](https://github.com/cloudflare/sandbox-sdk/pull/32) [`1a42464`](https://github.com/cloudflare/sandbox-sdk/commit/1a4246479369c5d0160705caf192aa1816540d52) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Bring back package README

## 0.1.2

### Patch Changes

- [#30](https://github.com/cloudflare/sandbox-sdk/pull/30) [`30e5c25`](https://github.com/cloudflare/sandbox-sdk/commit/30e5c25cf7d4b07f9049724206c531e2d5d29d5c) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Remove actions timeout

- [#29](https://github.com/cloudflare/sandbox-sdk/pull/29) [`d78508f`](https://github.com/cloudflare/sandbox-sdk/commit/d78508f7287a59e0423edd2999c2c83e9e34ccfd) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Create multi-platform Docker image and switch to Cloudflare official repo

## 0.1.1

### Patch Changes

- [`157dde9`](https://github.com/cloudflare/sandbox-sdk/commit/157dde9b1f23e9bb6f3e9c3f0514b639a8813897) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [`a04f6b6`](https://github.com/cloudflare/sandbox-sdk/commit/a04f6b6c0b2ef9e3ce0851b53769f1c10d8c6de6) Thanks [@threepointone](https://github.com/threepointone)! - trigger a build with updated deps

## 0.1.0

### Minor Changes

- [#24](https://github.com/cloudflare/sandbox-sdk/pull/24) [`cecde0a`](https://github.com/cloudflare/sandbox-sdk/commit/cecde0a7530a87deffd8562fb8b01d66ee80ee19) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Redesign command execution API

### Patch Changes

- [#22](https://github.com/cloudflare/sandbox-sdk/pull/22) [`f5fcd52`](https://github.com/cloudflare/sandbox-sdk/commit/f5fcd52025d1f7958a374e69d75e3fc590275f3f) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Allow setting env variables dynamically and remove command restrictions

## 0.0.9

### Patch Changes

- [#20](https://github.com/cloudflare/sandbox-sdk/pull/20) [`f106fda`](https://github.com/cloudflare/sandbox-sdk/commit/f106fdac98e7ef35677326290d45cbf3af88982c) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - add preview URLs and dynamic port forwarding

## 0.0.8

### Patch Changes

- [`60af265`](https://github.com/cloudflare/sandbox-sdk/commit/60af265d834e83fd30a921a3e1be232f13fe24da) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.7

### Patch Changes

- [`d1c7c99`](https://github.com/cloudflare/sandbox-sdk/commit/d1c7c99df6555eff71bcd59852e4b8eed2ad8cb6) Thanks [@threepointone](https://github.com/threepointone)! - fix file operations

## 0.0.6

### Patch Changes

- [#9](https://github.com/cloudflare/sandbox-sdk/pull/9) [`24f5470`](https://github.com/cloudflare/sandbox-sdk/commit/24f547048d5a26137de4656cea13d83ad2cc0b43) Thanks [@ItsWendell](https://github.com/ItsWendell)! - fix baseUrl for stub and stub forwarding

## 0.0.5

### Patch Changes

- [#5](https://github.com/cloudflare/sandbox-sdk/pull/5) [`7c15b81`](https://github.com/cloudflare/sandbox-sdk/commit/7c15b817899e4d9e1f25747aaf439e5e9e880d15) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Make package ready for deployment

## 0.0.4

### Patch Changes

- [`c0d9d33`](https://github.com/cloudflare/sandbox-sdk/commit/c0d9d3396badee1eab45e6b4a73d48957f31409b) Thanks [@threepointone](https://github.com/threepointone)! - actually work

- [`444d2da`](https://github.com/cloudflare/sandbox-sdk/commit/444d2dafde9a0f190e50c879b0e768da1b289b51) Thanks [@threepointone](https://github.com/threepointone)! - add experimental label

## 0.0.3

### Patch Changes

- [`2b087c4`](https://github.com/cloudflare/sandbox-sdk/commit/2b087c40a29697c20dad19b4e3b8512f5d404bd3) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix worker unable to find container port

## 0.0.2

### Patch Changes

- [`52f02f0`](https://github.com/cloudflare/sandbox-sdk/commit/52f02f0625ef9f8eac695e51f93fa79651c0206d) Thanks [@threepointone](https://github.com/threepointone)! - readFile

## 0.0.1

### Patch Changes

- [`f786c3c`](https://github.com/cloudflare/sandbox-sdk/commit/f786c3cee6bd9777bd74918ae9fdf381aa99f913) Thanks [@threepointone](https://github.com/threepointone)! - Release!
