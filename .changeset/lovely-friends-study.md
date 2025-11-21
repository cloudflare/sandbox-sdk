---
'@cloudflare/sandbox': patch
---

Add OpenAI Agents adapters

Add OpenAI Agents adapters (`Shell` and `Editor`) that integrate Cloudflare Sandbox with the OpenAI Agents SDK. These adapters enable AI agents to execute shell commands and perform file operations (create, update, delete) inside sandboxed environments. Both adapters automatically collect and timestamp results from operations, making it easy to track command execution and file modifications during agent sessions. The adapters are exported from `@cloudflare/sandbox/openai` and implement the OpenAI Agents `Shell` and `Editor` interfaces.
