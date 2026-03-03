---
'@cloudflare/sandbox': patch
---

Fix heredoc commands (e.g. `cat << 'EOF'`) hanging permanently and making the session unusable for subsequent commands.
