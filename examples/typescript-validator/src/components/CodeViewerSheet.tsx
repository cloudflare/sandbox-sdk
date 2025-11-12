import { useState } from 'react';
import { Highlight, themes } from 'prism-react-renderer';

interface CodeViewerSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CodeViewerSheet({
  isOpen,
  onClose
}: CodeViewerSheetProps) {
  const [activeTab, setActiveTab] = useState<'compilation' | 'execution'>(
    'compilation'
  );

  const compilationCode = `// Compile TypeScript with Sandbox SDK
import { getSandbox } from '@cloudflare/sandbox';

const sandbox = getSandbox(this.env.Sandbox, \`compile-\${sessionId}\`);

// Write TypeScript schema
await sandbox.writeFile('/workspace/validator.ts', body.schemaCode);

// Bundle with esbuild
// NODE_PATH is set to /base/node_modules to use pre-installed dependencies
const bundleResult = await sandbox.exec(
  'NODE_PATH=/base/node_modules esbuild validator.ts --bundle --format=esm --outfile=bundle.js',
  { timeout: 60000, cwd: '/workspace' }
);

// Read bundled code
const bundleFile = await sandbox.readFile('/workspace/bundle.js');
bundledCode = bundleFile.content;`;

  const executionCode = `// Execute in Dynamic Worker
// wrangler.jsonc: "worker_loaders": [{ "binding": "LOADER" }]

const worker = this.env.LOADER.get(codeHash, () => {
  return {
    compatibilityDate: '2025-11-09',
    mainModule: 'index.js',
    modules: {
      'index.js': \`
        import { schema } from './validator.js';

        export default {
          async fetch(request) {
            try {
              const data = await request.json();
              const result = schema.safeParse(data);
              return new Response(JSON.stringify(result), {
                headers: { 'content-type': 'application/json' }
              });
            } catch (error) {
              return new Response(JSON.stringify({
                error: 'Execution failed',
                details: error.message
              }), {
                status: 500,
                headers: { 'content-type': 'application/json' }
              });
            }
          }
        }
      \`,
      'validator.js': bundledCode
    },
    globalOutbound: null // No network access
  };
});

// Send request to dynamic worker
const testRequest = new Request('http://worker/validate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body.testData)
});

const response = await worker.getEntrypoint().fetch(testRequest);
const result = await response.json();`;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Sheet */}
      <div
        className={`fixed bottom-0 left-0 right-0 bg-bg-cream border-t-2 border-border-beige z-50 transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ height: '80vh' }}
      >
        <div className="flex flex-col h-full max-h-full">
          {/* Header */}
          <div className="px-6 py-4 border-b border-border-beige bg-bg-cream-dark flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-text-dark">Core Code</h2>
              <p className="text-sm text-text-medium mb-2">
                See how Sandbox SDK and Dynamic Workers work together
              </p>
              <div className="flex gap-4 text-xs">
                <a
                  href="https://developers.cloudflare.com/sandbox/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-primary hover:underline flex items-center gap-1"
                >
                  Sandbox SDK Docs
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
                <a
                  href="https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-primary hover:underline flex items-center gap-1"
                >
                  Dynamic Workers Docs
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-text-dark hover:text-orange-primary transition-colors"
              aria-label="Close"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border-beige bg-bg-cream-dark">
            <button
              onClick={() => setActiveTab('compilation')}
              className={`px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'compilation'
                  ? 'border-orange-primary text-orange-primary'
                  : 'border-transparent text-text-medium hover:text-text-dark'
              }`}
            >
              Compilation (Sandbox SDK)
            </button>
            <button
              onClick={() => setActiveTab('execution')}
              className={`px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'execution'
                  ? 'border-orange-primary text-orange-primary'
                  : 'border-transparent text-text-medium hover:text-text-dark'
              }`}
            >
              Execution (Dynamic Workers)
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6 bg-bg-cream-dark min-h-0">
            <Highlight
              theme={themes.github}
              code={
                activeTab === 'compilation' ? compilationCode : executionCode
              }
              language="typescript"
            >
              {({ className, style, tokens, getLineProps, getTokenProps }) => (
                <pre
                  className={`${className} overflow-x-auto`}
                  style={{ ...style, backgroundColor: 'transparent' }}
                >
                  {tokens.map((line, i) => (
                    <div key={i} {...getLineProps({ line })}>
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )}
            </Highlight>
          </div>
        </div>
      </div>
    </>
  );
}
