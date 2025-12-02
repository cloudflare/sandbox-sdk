---
'@cloudflare/sandbox': patch
---

Add top-level await support for JavaScript code execution

JavaScript code can now use `await` at the top level without wrapping in an async IIFE. Variables declared with `const`, `let`, or `var` persist across executions, enabling multi-step workflows like:

```javascript
// Execution 1
const data = await fetch('https://api.example.com').then((r) => r.json());

// Execution 2
console.log(data); // Works - data persists
```
