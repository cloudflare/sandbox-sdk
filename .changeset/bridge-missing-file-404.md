---
'@cloudflare/sandbox': patch
---

Return 404 with `workspace_read_not_found` from the bridge's `GET /v1/sandbox/:id/file/*` when the file doesn't exist. The route used to return 200 with an empty body, the same response as an empty file.
