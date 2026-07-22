import { useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const add = (message: string) =>
    setLog((lines) => [...lines, `${new Date().toISOString()} ${message}`]);

  const trigger = async () => {
    setRunning(true);
    setLog([]);
    add("Starting the 0.11.0 desktop container; this can take 2-3 minutes...");
    try {
      const response = await fetch("/api/reproduce", { method: "POST" });
      const body = await response.text();
      add(`HTTP ${response.status}`);
      try {
        const result = JSON.parse(body);
        add(JSON.stringify(result, null, 2));
        add(
          result.reproduced
            ? "BUG REPRODUCED: exec and port 6080 were healthy, but every preview request returned 410 STALE_PREVIEW_URL."
            : "Bug was not reproduced in this run; inspect the details above."
        );
      } catch {
        add(body);
      }
    } catch (error) {
      add(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", maxWidth: 960, margin: "2rem auto", padding: 16 }}>
      <h1>#829: STALE_PREVIEW_URL on healthy 0.11.0 desktop container</h1>
      <p>
        <strong>Expected:</strong> once <code>exposePort(6080)</code> succeeds, preview requests reach noVNC.
        {" "}<strong>Reported bug:</strong> every request returns <code>410 STALE_PREVIEW_URL</code> even though
        container exec and port 6080 are healthy.
      </p>
      <p>
        The temporary workers.dev deployment cannot own wildcard DNS, so the Worker feeds the generated preview
        request directly through <code>proxyToSandbox()</code>. This bypasses DNS only; it exercises the same
        middleware, Durable Object, runtime-activation checks, and port-forwarding path.
      </p>
      <p>
        <strong>Temporary-account limitation:</strong> temporary accounts serve this UI but do not provision
        Containers. Use the linked repro branch on a Containers-enabled account to run the trigger end-to-end;
        otherwise the button reports the platform's container-start error.
      </p>
      <button onClick={trigger} disabled={running} style={{ padding: "0.6rem 1rem" }}>
        {running ? "Running reproduction..." : "Trigger bug"}
      </button>
      <pre style={{ marginTop: 16, padding: 16, minHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", background: "#111", color: "#d6ffd6" }}>
        {log.length ? log.join("\n") : "Press Trigger bug and watch the log."}
      </pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
