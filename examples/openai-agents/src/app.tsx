import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import './index.css';

interface ToolResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface Response {
  naturalResponse: string | null;
  toolResults: ToolResult[];
}

async function makeApiCall(input: string): Promise<Response> {
  try {
    const response = await fetch('/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}

function App() {
  const [input, setInput] = useState('');
  const [response, setResponse] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    setLoading(true);
    setResponse(null);

    try {
      const result = await makeApiCall(input);
      setResponse(result);
    } catch (error) {
      console.error('Error:', error);
      setResponse({
        naturalResponse: 'An error occurred while processing your request.',
        toolResults: []
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app">
      <div className="container">
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            className="input"
            placeholder="Enter your natural language command..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
        </form>

        {loading && (
          <div className="output">
            <div className="output-content">Processing...</div>
          </div>
        )}

        {response && !loading && (
          <div className="output">
            {response.naturalResponse && (
              <div className="output-section">
                <div className="output-label">Response:</div>
                <div className="output-content">{response.naturalResponse}</div>
              </div>
            )}

            {response.toolResults.length > 0 && (
              <div className="output-section">
                <div className="output-label">Command Results:</div>
                {response.toolResults.map((result, index) => (
                  <div key={index} className="tool-result">
                    <div className="tool-command">$ {result.command}</div>
                    {result.stdout && (
                      <div className="tool-output">{result.stdout}</div>
                    )}
                    {result.stderr && (
                      <div className="tool-error">{result.stderr}</div>
                    )}
                    {result.exitCode !== null && result.exitCode !== 0 && (
                      <div className="tool-exit-code">
                        Exit code: {result.exitCode}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!response.naturalResponse && response.toolResults.length === 0 && (
              <div className="output-content">No response received.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
