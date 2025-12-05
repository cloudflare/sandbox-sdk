### 🐳 Docker Images Published

**Default (no Python):**

```dockerfile
FROM {{DEFAULT_TAG}}
```

**With Python:**

```dockerfile
FROM {{PYTHON_TAG}}
```

**Version:** `{{VERSION}}`

Use the `-python` variant if you need Python code execution.

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
