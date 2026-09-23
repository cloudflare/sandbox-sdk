---
'@cloudflare/sandbox': patch
---

Stop writing command arguments and output to Sandbox logs. `sandbox.exec` log events now record the executable name and argument count instead of the full command line, and the OpenAI Agents `Shell` adapter no longer logs commands or stderr, so secrets passed as arguments, headers, or environment assignments no longer reach Workers Logs.
