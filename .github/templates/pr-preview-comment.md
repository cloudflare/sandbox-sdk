### 🐳 Docker Images Published

| Variant            | Image                      |
| ------------------ | -------------------------- |
| Default            | `{{DEFAULT_TAG}}`          |
| Python             | `{{PYTHON_TAG}}`           |
| OpenCode           | `{{OPENCODE_TAG}}`         |
| Desktop            | `{{DESKTOP_TAG}}`          |
| Desktop + Python   | `{{DESKTOP_PYTHON_TAG}}`   |
| Desktop + OpenCode | `{{DESKTOP_OPENCODE_TAG}}` |

**Usage:**

```dockerfile
FROM {{DEFAULT_TAG}}
```

**Version:** `{{VERSION}}`

---

### 📦 Standalone Binary

**For arbitrary Dockerfiles:**

```dockerfile
COPY --from={{DEFAULT_TAG}} /container-server/sandbox /sandbox
ENTRYPOINT ["/sandbox"]
```

**Download via GitHub CLI:**

```bash
gh run download {{RUN_ID}} -n sandbox-binary
```

**Extract from Docker:**

```bash
docker run --rm {{DEFAULT_TAG}} cat /container-server/sandbox > sandbox && chmod +x sandbox
```
