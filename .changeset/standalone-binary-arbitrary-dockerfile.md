---
'@cloudflare/sandbox': patch
---

Add standalone binary support for arbitrary Dockerfiles

Users can now add sandbox capabilities to any Docker image:

```dockerfile
FROM your-image:tag

COPY --from=cloudflare/sandbox:VERSION /container-server/sandbox /sandbox
ENTRYPOINT ["/sandbox"]

# Optional: run your own startup command
CMD ["/your-entrypoint.sh"]
```

The `/sandbox` binary starts the HTTP API server, then executes any CMD as a child process with signal forwarding.

Includes backwards compatibility for existing custom startup scripts.
