# Page snapshot

```yaml
- generic [ref=e2]: 'Destroy/respawn bug test routes: GET /setup â€” start sandbox + expose port 8080 (prerequisite) GET /url â€” expose port + return real preview URL (open in browser) GET /destroy â€” explicitly destroy the sandbox GET /proxy â€” call proxyToSandbox after destroy (reproduces respawn bug) GET /state â€” check current container state Repro steps: 1. GET /setup â†’ sandbox starts, port exposed 2. GET /destroy â†’ sandbox destroyed 3. GET /proxy â†’ BUG: container is respawned by containerFetch Expected: stateAfterProxy != "healthy", respawned: false Actual: stateAfterProxy == "healthy", respawned: true'
```
