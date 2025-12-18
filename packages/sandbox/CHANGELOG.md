# @cloudflare/sandbox

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
  FROM cloudflare/sandbox:0.6.7

  # After
  FROM cloudflare/sandbox:0.6.7-python
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
