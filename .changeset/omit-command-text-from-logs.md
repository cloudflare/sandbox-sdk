---
'@cloudflare/sandbox': patch
---

Stop writing command text and output to Sandbox logs. Exec and process log events now record IDs, exit codes, durations, and output lengths, and the OpenAI Agents `Shell` adapter no longer logs commands or stderr, so secrets passed as arguments, headers, or environment assignments no longer reach Workers Logs or container logs. Command failure messages no longer repeat the command; it remains available on the error's `context.command`.
