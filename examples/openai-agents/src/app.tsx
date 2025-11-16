import { createRoot } from 'react-dom/client';
import { useState, useEffect, useRef } from 'react';
import './index.css';
import type { CommandResult, FileOperationResult } from './types';

interface Response {
  naturalResponse: string | null;
  commandResults: CommandResult[];
  fileOperations?: FileOperationResult[];
}

interface Message {
  id: string;
  input: string;
  response: Response | null;
  timestamp: number;
}

const STORAGE_KEY = 'openai-agents-history';

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
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load messages from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setMessages(parsed);
      } catch (error) {
        console.error('Error loading history:', error);
      }
    }
  }, []);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
  }, [messages]);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Focus input after response comes in
  useEffect(() => {
    if (!loading && messages.length > 0) {
      // Small delay to ensure DOM is updated
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [loading, messages.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userInput = input.trim();
    setInput('');
    setLoading(true);

    // Add user message immediately
    const userMessage: Message = {
      id: Date.now().toString(),
      input: userInput,
      response: null,
      timestamp: Date.now()
    };
    setMessages((prev) => [...prev, userMessage]);

    try {
      const result = await makeApiCall(userInput);
      // Update the message with the response
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === userMessage.id ? { ...msg, response: result } : msg
        )
      );
    } catch (error) {
      console.error('Error:', error);
      const errorResponse: Response = {
        naturalResponse: 'An error occurred while processing your request.',
        commandResults: [],
        fileOperations: []
      };
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === userMessage.id ? { ...msg, response: errorResponse } : msg
        )
      );
    } finally {
      setLoading(false);
    }
  };

  const clearHistory = () => {
    if (confirm('Are you sure you want to clear all history?')) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const renderMessage = (message: Message) => (
    <div key={message.id} className="message">
      <div className="message-input">
        <div className="message-label">You:</div>
        <div className="message-content">{message.input}</div>
      </div>

      {message.response ? (
        <div className="message-response">
          <div className="output-columns">
            <div className="output-column output-column-left">
              <div className="output-section">
                <div className="output-label">Response:</div>
                {message.response.naturalResponse ? (
                  <div className="output-content">
                    {message.response.naturalResponse}
                  </div>
                ) : (
                  <div className="output-content">No response received.</div>
                )}
              </div>
            </div>

            <div className="output-column output-column-right">
              {(() => {
                // Combine and sort all results by timestamp
                const allResults = [
                  ...message.response.commandResults.map((r) => ({
                    type: 'command' as const,
                    ...r
                  })),
                  ...(message.response.fileOperations || []).map((r) => ({
                    type: 'file' as const,
                    ...r
                  }))
                ].sort((a, b) => a.timestamp - b.timestamp);

                if (allResults.length === 0) {
                  return (
                    <div className="output-section">
                      <div className="output-label">Results:</div>
                      <div className="output-content">
                        No operations performed.
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="output-section">
                    <div className="output-label">Results:</div>
                    {allResults.map((result, index) => {
                      const timestamp = new Date(
                        result.timestamp
                      ).toLocaleTimeString();

                      if (result.type === 'command') {
                        return (
                          <div key={index} className="tool-result">
                            <div className="tool-header">
                              <div className="tool-command">
                                $ {result.command}
                              </div>
                              <div className="tool-timestamp">{timestamp}</div>
                            </div>
                            {result.stdout && (
                              <div className="tool-output">{result.stdout}</div>
                            )}
                            {result.stderr && (
                              <div className="tool-error">{result.stderr}</div>
                            )}
                            {result.exitCode !== null &&
                              result.exitCode !== 0 && (
                                <div className="tool-exit-code">
                                  Exit code: {result.exitCode}
                                </div>
                              )}
                          </div>
                        );
                      } else {
                        return (
                          <div key={index} className="tool-result">
                            <div className="tool-header">
                              <div className="tool-command">
                                {result.operation === 'create' && '📄 Create'}
                                {result.operation === 'update' && '✏️ Update'}
                                {result.operation === 'delete' &&
                                  '🗑️ Delete'}{' '}
                                {result.path}
                              </div>
                              <div className="tool-timestamp">{timestamp}</div>
                            </div>
                            <div
                              className={
                                result.status === 'completed'
                                  ? 'tool-output'
                                  : 'tool-error'
                              }
                            >
                              {result.output}
                            </div>
                            {result.error && (
                              <div className="tool-error">
                                Error: {result.error}
                              </div>
                            )}
                          </div>
                        );
                      }
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      ) : (
        <div className="message-response">
          <div className="output-content">Processing...</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1 className="app-title">Sandbox Studio</h1>
          {messages.length > 0 && (
            <button className="clear-button" onClick={clearHistory}>
              Clear History
            </button>
          )}
        </div>

        <div className="messages-container">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="output-content">
                Start a conversation by entering a command below.
              </div>
            </div>
          ) : (
            messages.map(renderMessage)
          )}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit} className="input-form">
          <input
            ref={inputRef}
            type="text"
            className="input"
            placeholder="Enter your natural language command..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
        </form>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
