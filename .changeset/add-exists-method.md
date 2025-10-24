---
"@cloudflare/sandbox": minor
---

Add exists() method to check if a file or directory exists

This adds a new `exists()` method to the SDK that checks whether a file or directory exists at a given path. The method returns a boolean indicating existence, similar to Python's `os.path.exists()` and JavaScript's `fs.existsSync()`.

The implementation is end-to-end:
- New `FileExistsResult` and `FileExistsRequest` types in shared package
- Handler endpoint at `/api/exists` in container layer
- Client method in `FileClient` and `Sandbox` classes
- Full test coverage (unit tests and E2E tests)
