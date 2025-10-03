---
"@cloudflare/sandbox": patch
---

comprehensive testing infrastructure and client architecture improvements

Establishes complete testing suite (476 tests) with unit, integration, container, and e2e coverage. Refactors monolithic HttpClient into domain-specific clients (Command, File, Process, Port, Git, Utility) with enhanced error handling. Fixes critical port access control vulnerability and enhances preview URL security with mandatory tokens. Solves Build ID problem enabling container testing. Maintains 100% backward compatibility.
