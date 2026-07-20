import { useState } from "react";
import { createRoot } from "react-dom/client";

type Result = {
  reproduced?: boolean;
  expected?: string;
  observed?: string;
  sequence?: Record<string, unknown>;
  error?: { name?: string; message?: string; stack?: string };
};

function App() {
  const [status, setStatus] = useState("Ready");
  const [result, setResult] = useState<Result | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const add = (message: string) =>
    setLog((lines) => [...lines, `${new Date().toISOString()} ${message}`]);

  async function trigger() {
    setResult(null);
    setStatus("Running the state-check → stop → createBackup sequence…");
    add("Triggering /api/reproduce (the first container provision can take a few minutes)");
    try {
      const response = await fetch("/api/reproduce", { method: "POST" });
      const body = (await response.json()) as Result;
      setResult(body);
      add(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      setStatus(
        body.reproduced
          ? "BUG REPRODUCED: createBackup() woke the stopped container"
          : response.ok
            ? "Sequence completed, but the bug was not observed"
            : "Reproduction request failed"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ error: { message } });
      setStatus("Request failed");
      add(`Request error: ${message}`);
    }
  }

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: 20, maxWidth: 1000 }}>
      <h1>#825: createBackup() wakes a stopped container</h1>
      <p>
        <strong>Expected:</strong> an already-running-only backup operation should refuse after
        the container stops, without waking it.
      </p>
      <p>
        <strong>Actual bug:</strong> SDK 0.12.3 routes backup transport calls through
        containerFetch(), whose startup path changes the stopped container back to healthy and
        lets the backup complete. The live demo runs the unmodified SDK with deterministic
        in-memory Container/R2 boundaries because temporary preview accounts cannot provision
        Container applications.
      </p>
      <button onClick={trigger} style={{ padding: "10px 16px", cursor: "pointer" }}>
        Trigger bug
      </button>
      <p><strong>Status:</strong> {status}</p>
      {result && <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre>}
      <h2>Client log</h2>
      <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
