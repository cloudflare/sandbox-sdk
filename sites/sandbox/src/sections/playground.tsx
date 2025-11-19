import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock, DotBox, GridBox } from '../components/grid';
import { TextShadow } from '../components/text-shadow';

function generateCode(repo: string, command: string): string {
  return `<pre class="shiki custom-theme" style="background-color:var(--background);color:var(--foreground);overflow-x:auto" tabindex="0"><code><span class="line"><span style="color:var(--foreground);font-weight:bold">import</span><span style="color:var(--foreground)"> { getSandbox } </span><span style="color:var(--foreground);font-weight:bold">from</span><span style="color:var(--color-orange-800)"> "@cloudflare/sandbox"</span><span style="color:var(--foreground)">;</span></span>
<span class="line"></span>
<span class="line"><span style="color:var(--color-neutral-400)">// Export the Sandbox class in your Worker</span></span>
<span class="line"><span style="color:var(--foreground);font-weight:bold">export</span><span style="color:var(--foreground)"> { Sandbox } </span><span style="color:var(--foreground);font-weight:bold">from</span><span style="color:var(--color-orange-800)"> "@cloudflare/sandbox"</span><span style="color:var(--foreground)">;</span></span>
<span class="line"></span>
<span class="line"><span style="color:var(--foreground);font-weight:bold">export</span><span style="color:var(--foreground);font-weight:bold"> default</span><span style="color:var(--foreground)"> {</span></span>
<span class="line"><span style="color:var(--foreground)">  async fetch(request</span><span style="color:var(--foreground);font-weight:bold">:</span><span style="color:var(--foreground)"> Request, env</span><span style="color:var(--foreground);font-weight:bold">:</span><span style="color:var(--foreground)"> Env) {</span></span>
<span class="line"><span style="color:var(--foreground)">    const sandbox </span><span style="color:var(--foreground);font-weight:bold">=</span><span style="color:var(--foreground)"> getSandbox(env.Sandbox, </span><span style="color:var(--color-orange-800)">"test-env"</span><span style="color:var(--foreground)">);</span></span>
<span class="line"><span style="color:var(--color-neutral-400)">    // Clone a repository</span></span>
<span class="line"><span style="color:var(--foreground);font-weight:bold">    await</span><span style="color:var(--foreground)"> sandbox.gitCheckout(</span></span>
<span class="line"><span style="color:var(--color-orange-800)">      "${repo}"</span></span>
<span class="line"><span style="color:var(--foreground)">    );</span></span>
<span class="line"><span style="color:var(--color-neutral-400)">    // Run tests</span></span>
<span class="line"><span style="color:var(--foreground)">    const testResult </span><span style="color:var(--foreground);font-weight:bold">=</span><span style="color:var(--foreground);font-weight:bold"> await</span><span style="color:var(--foreground)"> sandbox.exec(</span></span>
<span class="line"><span style="color:var(--color-orange-800)">      "${command}"</span></span>
<span class="line"><span style="color:var(--foreground)">    );</span></span>
<span class="line"><span style="color:var(--foreground);font-weight:bold">    return</span><span style="color:var(--foreground);font-weight:bold"> new</span><span style="color:var(--foreground)"> Response(</span></span>
<span class="line"><span style="color:var(--foreground)">      JSON.stringify({</span></span>
<span class="line"><span style="color:var(--foreground)">        tests: testResult.exitCode </span><span style="color:var(--foreground);font-weight:bold">===</span><span style="color:var(--foreground)"> 0 </span></span>
<span class="line"><span style="color:var(--foreground);font-weight:bold">          ?</span><span style="color:var(--color-orange-800)"> "passed"</span></span>
<span class="line"><span style="color:var(--foreground);font-weight:bold">          :</span><span style="color:var(--color-orange-800)"> "failed"</span><span style="color:var(--foreground)">,</span></span>
<span class="line"><span style="color:var(--foreground)">        output: testResult.stdout,</span></span>
<span class="line"><span style="color:var(--foreground)">      })</span></span>
<span class="line"><span style="color:var(--foreground)">    );</span></span>
<span class="line"><span style="color:var(--foreground)">  },</span></span>
<span class="line"><span style="color:var(--foreground)">};</span></span></code></pre>`;
}

export function Playground() {
  const [repo, setRepo] = useState('https://github.com/cloudflare/agents');
  const [command, setCommand] = useState('npm i && npm run build');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const code = useMemo(() => generateCode(repo, command), [repo, command]);

  // Scroll to bottom when output changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: we need this to happen when the output changes
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    setOutput('');

    try {
      const response = await fetch('/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ repo, command })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Handle SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';
      let currentOutput = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));

              switch (event.type) {
                case 'stdout':
                  currentOutput += event.data;
                  setOutput(currentOutput);
                  break;
                case 'stderr':
                  currentOutput += `[stderr] ${event.data}`;
                  setOutput(currentOutput);
                  break;
                case 'complete':
                  currentOutput += `\n\n--- Process completed with exit code: ${event.exitCode} ---`;
                  setOutput(currentOutput);
                  break;
                case 'error':
                  setError(event.message || 'An error occurred');
                  break;
              }
            } catch (parseError) {
              console.error('Failed to parse SSE event:', parseError);
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setOutput('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="lg:grid lg:grid-cols-8 lg:border-l lg:auto-rows-fr flex flex-col lg:block">
      {/* Desktop decorative grid cells */}
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
          key={index}
          className="hidden lg:block border-r border-b aspect-square"
        />
      ))}

      {/* Mobile: Section title */}
      <div className="lg:hidden border p-6 flex items-center justify-center">
        <h2 className="text-6xl sm:text-7xl font-medium">
          <TextShadow text="Playground" count={3} gap="-0.6em" />
        </h2>
      </div>
      {/* Desktop: Large title */}
      <GridBox
        x={2}
        width={4}
        className="hidden lg:flex overflow-hidden items-end justify-center"
      >
        <p className="text-[120px] font-medium translate-y-2">
          <TextShadow text="Playground" count={5} gap="-0.6em" />
        </p>
      </GridBox>

      {/* Desktop: Code block */}
      <GridBox y={1} height={4} width={4} className="hidden lg:block">
        <CodeBlock>{code}</CodeBlock>
      </GridBox>

      {/* Mobile: Code block */}
      <div className="lg:hidden border border-t-0 overflow-x-auto">
        <CodeBlock>{code}</CodeBlock>
      </div>

      {/* Desktop: Interactive panel */}
      <GridBox x={4} y={1} height={4} width={4} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full flex flex-col min-h-0">
            <div className="relative bg-background w-full flex-1 border border-b-0 flex flex-col min-h-0">
              <div className="h-6 border-b" />
              <div className="p-4 space-y-3 border-b">
                <div>
                  <label
                    htmlFor="repo-input"
                    className="block text-xs font-mono mb-1 text-foreground/60"
                  >
                    Repository URL
                  </label>
                  <input
                    id="repo-input"
                    type="text"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    className="w-full px-2 py-1 text-sm font-mono border border-foreground/20 bg-background focus:outline-none focus:border-foreground/40"
                    placeholder="https://github.com/cloudflare/agents"
                  />
                </div>
                <div>
                  <label
                    htmlFor="command-input"
                    className="block text-xs font-mono mb-1 text-foreground/60"
                  >
                    Command
                  </label>
                  <input
                    id="command-input"
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    className="w-full px-2 py-1 text-sm font-mono border border-foreground/20 bg-background focus:outline-none focus:border-foreground/40"
                    placeholder="npm test"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={loading || !repo || !command}
                  className="w-full px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? 'Running...' : 'Run'}
                </button>
              </div>
              <div ref={outputRef} className="flex-1 overflow-auto min-h-0">
                <div className="font-mono text-sm p-4 whitespace-pre-wrap break-words">
                  {error ? (
                    <span className="text-red-600">Error: {error}</span>
                  ) : output ? (
                    output
                  ) : (
                    <span className="text-foreground/40">
                      Output will appear here...
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </DotBox>
      </GridBox>

      {/* Mobile: Interactive panel */}
      <div className="lg:hidden border border-t-0">
        <div className="p-4 bg-background w-full flex flex-col">
          <div className="space-y-3 pb-4 border-b">
            <div>
              <label
                htmlFor="repo-input-mobile"
                className="block text-xs font-mono mb-1 text-foreground/60"
              >
                Repository URL
              </label>
              <input
                id="repo-input-mobile"
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono border border-foreground/20 bg-background focus:outline-none focus:border-foreground/40"
                placeholder="https://github.com/cloudflare/agents"
              />
            </div>
            <div>
              <label
                htmlFor="command-input-mobile"
                className="block text-xs font-mono mb-1 text-foreground/60"
              >
                Command
              </label>
              <input
                id="command-input-mobile"
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono border border-foreground/20 bg-background focus:outline-none focus:border-foreground/40"
                placeholder="npm test"
              />
            </div>
            <button
              type="button"
              onClick={handleRun}
              disabled={loading || !repo || !command}
              className="w-full px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Running...' : 'Run'}
            </button>
          </div>
          <div className="pt-4 min-h-[400px] max-h-[600px] overflow-auto">
            <div className="font-mono text-sm whitespace-pre-wrap break-words">
              {error ? (
                <span className="text-red-600">Error: {error}</span>
              ) : output ? (
                output
              ) : (
                <span className="text-foreground/40">
                  Output will appear here...
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
