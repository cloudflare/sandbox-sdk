import { writeFileSync } from "node:fs";

let count = 0;

setInterval(() => {
	count++;
	writeFileSync(
		"/app/src/App.jsx",
		`export default function App() {
  return (
    <div>
      <h1>Vite + React + Cloudflare Sandbox</h1>
      <p>Counter: <strong>${count}</strong></p>
    </div>
  );
}\n`,
	);
}, 1000);
