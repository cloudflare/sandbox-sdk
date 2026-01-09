---
'@cloudflare/sandbox': patch
---

Handle undefined environment variables as "unset" in setEnvVars

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
