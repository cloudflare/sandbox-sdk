---
'@cloudflare/sandbox': patch
---

Stop writing command text and output to Sandbox logs. Exec and process log events now record IDs, exit codes, durations, and output lengths, and the OpenAI Agents `Shell` and `Editor` adapters no longer log commands, stderr, or patch text, so secrets in commands, output, or patches no longer reach Workers Logs or container logs. Command failure messages no longer repeat the command; it remains available on the error's `context.command`.
