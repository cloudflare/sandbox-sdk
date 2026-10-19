---
'@cloudflare/sandbox': patch
---

Stop writing command arguments and output to Sandbox logs. `sandbox.exec` log events now record the executable name and argument count instead of the full command line, and the OpenAI Agents `Shell` and `Editor` adapters no longer log commands, stderr, or patch text, so secrets in commands, output, or patches no longer reach Workers Logs.
