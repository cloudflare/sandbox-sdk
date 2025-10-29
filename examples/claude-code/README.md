# Claude Code 🧡 Sandbox SDK

Run Claude Code for on Cloudflare Sandboxes! This example shows a basic setup that does the following:

- The worker accepts POST requests that include a repository URL and a task description
- The worker spawns a sandbox, clones the repository and starts Claude Code in headless mode with the provided task
- Claude Code will edit all necessary files and return when done
- The Worker will return a response with the output logs from Claude and the diff left on the repo.

Happy hacking!
