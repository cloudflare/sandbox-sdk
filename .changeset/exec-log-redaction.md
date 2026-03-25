---
'@cloudflare/sandbox': patch
---

Add entropy-based log redaction for exec commands

Sensitive values in logged exec commands are now partially redacted before
they reach log output. Redaction applies to shell variable assignments
(`export KEY=VALUE`, inline env prefixes), sensitive CLI flags (`--token`,
`--password`, etc.), and high-entropy tokens detected via Shannon entropy.

This is log-only: command execution, HTTP contracts, method return values,
and all runtime behavior are unchanged.
