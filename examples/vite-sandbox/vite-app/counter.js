import { writeFileSync } from 'node:fs';

let count = 0;

setInterval(() => {
  count++;
  writeFileSync(
    '/app/src/main.js',
    `document.querySelector('#app').innerHTML = \`
  <h1>Vite + Cloudflare Sandbox</h1>
  <p>Counter: <strong>${count}</strong></p>
\`\n`
  );
}, 1000);
