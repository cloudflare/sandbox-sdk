---
'@cloudflare/sandbox': patch
---

Clarify in documentation that EXPOSE directives are not required by the platform, all ports are accessible in both local dev and production by default. EXPOSE is still recommended as it documents which ports an application uses, following standard Docker convention.
