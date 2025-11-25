---
'@cloudflare/sandbox': patch
---

Fix code context isolation bug where contexts leaked state after 10 executions. Each code context now gets a dedicated executor process from creation to deletion, ensuring complete isolation between contexts. Removed maximum pool size limits to allow organic scaling.
