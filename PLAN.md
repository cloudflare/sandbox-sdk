# Plan: Add `labels` support to `getSandbox()` / `SandboxOptions`

## Goal

Implement the API requested in [cloudflare/sandbox-sdk#790](https://github.com/cloudflare/sandbox-sdk/issues/790):

```ts
const sandbox = getSandbox(env.Sandbox, id, {
  labels: {
    tenantId: 'tenant_123',
    workload: 'code-workspace'
  }
});
```

Those labels should be attached to the underlying Cloudflare Container at start time so they are available in Containers analytics queries such as `labels_has` and `label(name: "...")`.

## Current behavior

- `@cloudflare/containers` supports labels through `ContainerStartConfigOptions.labels`.
- Worker runtime types also expose `ctx.container.start({ labels })` through `ContainerStartupOptions.labels`.
- `SandboxOptions` currently has no `labels` field.
- `getSandbox()` applies options by building a `SandboxConfiguration` and sending it to the Sandbox Durable Object via `configure()`.
- `Sandbox.containerFetch()` lazy-starts the container with `this.startAndWaitForPorts({ ports, cancellationOptions })` and does not pass explicit start options.
- Because `Sandbox` extends `Container`, the inherited `this.labels` field can already be used by the lower-level `@cloudflare/containers` start path, but the Sandbox SDK does not expose or persist it as part of the public `getSandbox()` API.

## Desired semantics

1. `labels` is a first-class `SandboxOptions` field.
2. Labels are start-time metadata for the underlying container.
3. Labels are persisted in the Sandbox Durable Object so they survive Worker isolate cache misses and Durable Object re-instantiation.
4. Reapplying identical labels is a no-op and must not reset sleep/activity timers.
5. If labels are changed while the container is already running, the running container is not relabeled because the Containers runtime only accepts labels at start time. The new labels apply on the next container start.
6. The SDK should document the start-time behavior clearly.

## Public API shape

Add to `SandboxOptions`:

```ts
export interface SandboxOptions {
  // ...existing options...

  /**
   * Key-value metadata labels attached to the underlying Cloudflare Container
   * for metrics and observability.
   *
   * Labels are applied when the container starts. Updating labels while a
   * container is already running only affects the next start/restart.
   *
   * @example
   * getSandbox(ns, id, {
   *   labels: {
   *     tenantId: 'tenant_123',
   *     workload: 'code-workspace'
   *   }
   * })
   */
  labels?: Record<string, string>;
}
```

## Implementation steps

### 1. Add `labels` to shared types

File: `packages/shared/src/types.ts`

- Add `labels?: Record<string, string>` to `SandboxOptions`.
- Include JSDoc explaining:
  - labels are for container analytics / observability;
  - labels are start-time only;
  - changes while running apply to the next start.

### 2. Add labels to Sandbox configuration plumbing

File: `packages/sandbox/src/sandbox.ts`

Update these internal types:

```ts
type SandboxConfiguration = {
  sandboxName?: { name: string; normalizeId?: boolean };
  sleepAfter?: string | number;
  keepAlive?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
  transport?: SandboxTransport;
  labels?: NonNullable<SandboxOptions['labels']>;
};

type CachedSandboxConfiguration = {
  sandboxName?: string;
  normalizeId?: boolean;
  sleepAfter?: string | number;
  keepAlive?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
  transport?: SandboxTransport;
  labels?: NonNullable<SandboxOptions['labels']>;
};
```

Update `ConfigurableSandboxStub`:

```ts
type ConfigurableSandboxStub = {
  configure?: (configuration: SandboxConfiguration) => Promise<void>;
  // ...existing setters...
  setLabels?: (labels: Record<string, string>) => Promise<void>;
};
```

### 3. Implement stable label comparison

Add a helper next to `sameContainerTimeouts()`:

```ts
function sameLabels(
  left?: Record<string, string>,
  right?: Record<string, string>
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;

  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;

  for (const [key, value] of leftEntries) {
    if (right[key] !== value) return false;
  }

  return true;
}
```

Rationale:

- Avoid `JSON.stringify()` order sensitivity.
- Preserve current configuration-cache behavior: identical reapplies do not invoke RPC.
- Treat `{}` as distinct from `undefined` so callers can intentionally clear labels for future starts.

### 4. Include labels in `buildSandboxConfiguration()`

Update `buildSandboxConfiguration()`:

```ts
if (
  options?.labels !== undefined &&
  !sameLabels(cached?.labels, options.labels)
) {
  configuration.labels = options.labels;
}
```

Do not mutate the caller's object. To avoid later caller-side mutation corrupting the in-memory cache or DO state, clone labels before caching/persisting. A small helper is useful:

```ts
function cloneLabels(labels: Record<string, string>): Record<string, string> {
  return { ...labels };
}
```

Then set:

```ts
configuration.labels = cloneLabels(options.labels);
```

### 5. Include labels in configuration presence and cache merge

Update `hasSandboxConfiguration()`:

```ts
return (
  configuration.sandboxName !== undefined ||
  configuration.sleepAfter !== undefined ||
  configuration.keepAlive !== undefined ||
  configuration.containerTimeouts !== undefined ||
  configuration.transport !== undefined ||
  configuration.labels !== undefined
);
```

Update `mergeSandboxConfiguration()`:

```ts
...(configuration.labels !== undefined && {
  labels: cloneLabels(configuration.labels)
})
```

### 6. Apply labels through direct setter fallback

Update `applySandboxConfiguration()` so old / partial stubs can still be configured if `configure()` is missing:

```ts
if (configuration.labels !== undefined) {
  operations.push(stub.setLabels?.(configuration.labels) ?? Promise.resolve());
}
```

### 7. Store and restore labels in `Sandbox`

File: `packages/sandbox/src/sandbox.ts`

The `Sandbox` class inherits `labels` from `Container`. Use that field as the source consumed by `@cloudflare/containers` when lazy-starting.

In the constructor's `blockConcurrencyWhile()` restore path, add storage restoration next to `sleepAfter`, `keepAliveEnabled`, `containerTimeouts`, and `transport` restoration:

```ts
const storedLabels =
  await this.ctx.storage.get<Record<string, string>>('labels');
if (storedLabels !== undefined) {
  this.labels = cloneLabels(storedLabels);
}
```

Exact placement should be inside the existing constructor initialization block where other persisted configuration is restored, not in a separate racing async task.

### 8. Add `setLabels()` on `Sandbox`

Add an RPC method near other configuration setters (`setSleepAfter`, `setKeepAlive`, `setContainerTimeouts`, `setTransport`):

```ts
async setLabels(labels: Record<string, string>): Promise<void> {
  const nextLabels = cloneLabels(labels);

  if (sameLabels(this.labels, nextLabels)) return;

  await this.ctx.storage.put('labels', nextLabels);
  this.labels = nextLabels;

  if (this.ctx.container?.running === true) {
    this.logger.warn(
      'Container labels updated while container is running; new labels apply on the next container start'
    );
  }
}
```

Important details:

- Do **not** call `renewActivityTimeout()` from `setLabels()`. Updating metadata should not extend container lifetime.
- Do **not** restart the container automatically. That would be surprising and could interrupt workloads.
- Do **not** call `ctx.container.start()` directly. The existing Sandbox/Containers lazy-start path already uses `this.labels`.
- Clone the labels before storing and assigning.

### 9. Wire labels into `configure()`

Update `Sandbox.configure()`:

```ts
if (configuration.labels !== undefined) {
  await this.setLabels(configuration.labels);
}
```

Ordering recommendation:

- Labels can be applied after `transport` / `containerTimeouts`; they do not depend on those fields.
- Keep all configuration operations sequential, consistent with the existing `configure()` method.

### 10. Validate or intentionally do not validate labels

Recommended initial approach: do not add additional SDK-level validation beyond TypeScript's `Record<string, string>`.

Rationale:

- The underlying Containers runtime defines the accepted labels contract.
- Over-validating in the SDK risks diverging from runtime behavior.
- If runtime limits exist, document them later when authoritative docs are available.

Optional defensive behavior:

- If label values may be non-string at runtime due to JavaScript users, coerce? Prefer **not** to coerce silently. Let runtime / storage reject invalid data or add explicit validation only if product requirements demand it.

### 11. Update docs

Potential files:

- `packages/sandbox/README.md`
- `packages/sandbox/CHANGELOG.md` only via changeset-generated release notes, not manual unless project convention requires.
- Site docs / examples if there is a configuration-options page.

Add an example:

```ts
const sandbox = getSandbox(env.Sandbox, 'tenant-workspace', {
  sleepAfter: '30m',
  labels: {
    tenantId: 'tenant_123',
    workload: 'code-workspace'
  }
});
```

Add note:

> Container labels are applied when the underlying container starts. If labels are changed while a container is already running, the new labels apply the next time the container starts.

### 12. Add a changeset

Add a changeset for `@cloudflare/sandbox`:

```md
---
'@cloudflare/sandbox': minor
---

Add `labels` to `SandboxOptions` so `getSandbox()` can attach Cloudflare Container labels for analytics and observability. Labels are applied on container start; updates while running apply on the next start.
```

Use `minor` because this is a public API addition.

## Test plan

### Unit tests: `packages/sandbox/tests/get-sandbox.test.ts`

Add tests covering client-side option plumbing and cache behavior.

#### Test: labels are included in initial configure

```ts
it('should apply labels option', () => {
  const mockNamespace = {} as any;

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: {
      tenantId: 'tenant_123',
      workload: 'code-workspace'
    }
  });

  expect(mockStub.configure).toHaveBeenCalledWith({
    sandboxName: {
      name: 'test-sandbox',
      normalizeId: undefined
    },
    labels: {
      tenantId: 'tenant_123',
      workload: 'code-workspace'
    }
  });
});
```

#### Test: labels compose with existing options

```ts
it('should apply labels alongside other options', () => {
  const mockNamespace = {} as any;

  getSandbox(mockNamespace, 'test-sandbox', {
    sleepAfter: '5m',
    keepAlive: true,
    transport: 'websocket',
    labels: { workload: 'code-workspace' }
  });

  expect(mockStub.configure).toHaveBeenCalledWith({
    sandboxName: {
      name: 'test-sandbox',
      normalizeId: undefined
    },
    sleepAfter: '5m',
    keepAlive: true,
    transport: 'websocket',
    labels: { workload: 'code-workspace' }
  });
});
```

#### Test: repeated identical labels are skipped

```ts
it('should skip repeated labels configuration for the same sandbox', async () => {
  const mockNamespace = {} as any;

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: { tenantId: 'tenant_123' }
  });
  await Promise.resolve();

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: { tenantId: 'tenant_123' }
  });

  expect(mockStub.configure).toHaveBeenCalledTimes(1);
});
```

#### Test: labels compare independent of insertion order

```ts
it('should treat labels with the same key-values as identical regardless of insertion order', async () => {
  const mockNamespace = {} as any;

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: { tenantId: 'tenant_123', workload: 'code-workspace' }
  });
  await Promise.resolve();

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: { workload: 'code-workspace', tenantId: 'tenant_123' }
  });

  expect(mockStub.configure).toHaveBeenCalledTimes(1);
});
```

#### Test: changed labels reconfigure only labels

```ts
it('should reconfigure when labels change', async () => {
  const mockNamespace = {} as any;

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: { tenantId: 'tenant_123' }
  });
  await Promise.resolve();

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: { tenantId: 'tenant_456' }
  });

  expect(mockStub.configure).toHaveBeenCalledTimes(2);
  expect(mockStub.configure).toHaveBeenNthCalledWith(2, {
    labels: { tenantId: 'tenant_456' }
  });
});
```

#### Test: empty labels can clear future start labels

```ts
it('should allow empty labels to clear configured labels for future starts', async () => {
  const mockNamespace = {} as any;

  getSandbox(mockNamespace, 'test-sandbox', {
    labels: { tenantId: 'tenant_123' }
  });
  await Promise.resolve();

  getSandbox(mockNamespace, 'test-sandbox', { labels: {} });

  expect(mockStub.configure).toHaveBeenCalledTimes(2);
  expect(mockStub.configure).toHaveBeenNthCalledWith(2, { labels: {} });
});
```

### Unit tests: `packages/sandbox/tests/sandbox.test.ts`

Add tests covering Durable Object behavior.

#### Test: `configure()` applies labels

```ts
it('configure() applies labels to the inherited container labels field', async () => {
  await sandbox.configure({ labels: { tenantId: 'tenant_123' } });

  expect((sandbox as any).labels).toEqual({ tenantId: 'tenant_123' });
  expect(mockCtx.storage.put).toHaveBeenCalledWith('labels', {
    tenantId: 'tenant_123'
  });
});
```

#### Test: repeated identical labels do not reset activity timeout

Add this to the existing `describe('configure() idempotency', ...)` block:

```ts
it('does not renew activity timeout on repeated identical labels', async () => {
  const renewSpy = vi.spyOn(sandbox as any, 'renewActivityTimeout');

  await sandbox.configure({ labels: { tenantId: 'tenant_123' } });
  const renewCallsAfterFirst = renewSpy.mock.calls.length;

  await sandbox.configure({ labels: { tenantId: 'tenant_123' } });

  expect(renewSpy.mock.calls.length).toBe(renewCallsAfterFirst);
});
```

This test should pass because `setLabels()` must not call `renewActivityTimeout()` at all.

#### Test: labels are cloned to avoid caller mutation

```ts
it('clones labels before storing them', async () => {
  const labels = { tenantId: 'tenant_123' };

  await sandbox.setLabels(labels);
  labels.tenantId = 'mutated';

  expect((sandbox as any).labels).toEqual({ tenantId: 'tenant_123' });
});
```

#### Test: constructor restores persisted labels

Use the same storage mock pattern used for persisted `sleepAfter`, `containerTimeouts`, or `transport` tests in `sandbox.test.ts`.

Expected assertion:

```ts
expect((restoredSandbox as any).labels).toEqual({ tenantId: 'tenant_123' });
```

### Runtime / integration test option

If there is an existing e2e worker that can inspect container analytics, that would be ideal, but likely unnecessary for this PR because:

- the Containers SDK already tests/owns forwarding `this.labels` to `ctx.container.start()`;
- Sandbox SDK only needs to prove it sets `this.labels` before lazy start.

A lighter integration-style unit test can mock or spy on `startAndWaitForPorts()` / inherited `container.start()` if existing test scaffolding supports it, but this is not required if unit coverage is solid.

## Validation commands

From repo root:

```sh
npm install
npm run test -w @cloudflare/sandbox -- get-sandbox.test.ts sandbox.test.ts
npm run typecheck -w @cloudflare/sandbox
npm run check -w @cloudflare/sandbox
```

If workspace scripts do not pass forwarded test file args as expected, use the package script directly:

```sh
cd packages/sandbox
npm run test -- tests/get-sandbox.test.ts tests/sandbox.test.ts
npm run typecheck
```

Before opening the PR, run at least:

```sh
npm run check
```

## Edge cases and decisions

### Existing running containers

Changing labels while a container is running cannot relabel that live container. The implementation should not try to destroy/restart automatically. It should:

- persist new labels;
- set `this.labels` for future starts;
- optionally log a warning when `this.ctx.container?.running === true`.

### Empty labels

`labels: {}` should mean "clear configured labels for future starts." It should be persisted as `{}` and passed through as an empty object. The underlying Containers start path only adds labels to `startConfig` when the object has keys, effectively resulting in no labels on future starts.

### Omitted labels

Omitting `labels` should not change existing labels. This is consistent with other `SandboxOptions` fields: unspecified fields are not reconfigured.

### Cache mutation safety

Because labels are objects, cache and DO state should use cloned objects. Without cloning, code like this could mutate the cached configuration after `getSandbox()` returns:

```ts
const labels = { tenantId: 'tenant_123' };
getSandbox(ns, id, { labels });
labels.tenantId = 'tenant_456';
```

### Storage failure semantics

`setLabels()` should update in-memory `this.labels` only after `ctx.storage.put('labels', nextLabels)` succeeds. This mirrors the desired behavior of other setters: if persistence fails, in-memory and durable state should not diverge.

### Label key/value validation

Do not invent validation rules in this PR unless Containers runtime documentation requires them. TypeScript's `Record<string, string>` is sufficient for the public API addition.

## Suggested PR breakdown

1. Type and configuration plumbing.
2. `Sandbox.setLabels()` + persisted restore.
3. Unit tests for `getSandbox()` option behavior.
4. Unit tests for `Sandbox.configure()` / persistence behavior.
5. README docs and changeset.
6. Validation run and PR notes.

## PR description draft

````md
## Summary

Adds `labels` to `SandboxOptions`, allowing callers to attach Cloudflare Container labels through `getSandbox()`:

```ts
const sandbox = getSandbox(env.Sandbox, id, {
  labels: {
    tenantId: 'tenant_123',
    workload: 'code-workspace'
  }
});
```
````

Labels are persisted on the Sandbox Durable Object and applied when the underlying container starts. Updating labels while a container is already running affects the next start/restart.

Fixes #790.

## Tests

- npm run test -w @cloudflare/sandbox -- get-sandbox.test.ts sandbox.test.ts
- npm run typecheck -w @cloudflare/sandbox

```

```
