### 🐳 Docker Images Published

**Default:**

```dockerfile
FROM {{DEFAULT_TAG}}
```

**With Python:**

```dockerfile
FROM {{PYTHON_TAG}}
```

**With OpenCode:**

```dockerfile
FROM {{OPENCODE_TAG}}
```

**Version:** `{{VERSION}}`

Use the `-python` variant if you need Python code execution, or `-opencode` for the variant with OpenCode AI coding agent pre-installed.

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
