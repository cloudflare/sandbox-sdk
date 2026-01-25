---
'@cloudflare/sandbox': minor
---

Add custom environment variable support to OpenCode integration.

Pass additional environment variables to the OpenCode process using the new `env` option:

```typescript
const { client, server } = await createOpencode(sandbox, {
  config: myConfig,
  env: {
    TRACEPARENT: '00-abc123-def456-01',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318'
  }
});
```

Custom env vars are merged with config-extracted variables (like API keys) and can override them if needed.
