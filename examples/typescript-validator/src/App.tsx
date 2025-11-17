import { useState } from 'react';
import CodeViewerSheet from './components/CodeViewerSheet';
import CornerSquares from './components/CornerSquares';
import FlowDiagram from './components/FlowDiagram';
import SchemaEditor from './components/SchemaEditor';
import TestDataPanel from './components/TestDataPanel';
import type { ErrorResponse, StatusLine, ValidateResponse } from './types';

const DEFAULT_SCHEMA = `import { z } from 'zod';

export const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number().min(18, 'Must be 18 or older'),
  email: z.string().email('Invalid email'),
});`;

const DEFAULT_TEST_DATA = {
  name: 'Alice',
  age: 30,
  email: 'alice@example.com'
};

// Get or create session ID
function getSessionId(): string {
  let sessionId = localStorage.getItem('validator-session-id');
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem('validator-session-id', sessionId);
  }
  return sessionId;
}

export default function App() {
  const [schemaCode, setSchemaCode] = useState(DEFAULT_SCHEMA);
  const [testData, setTestData] = useState(
    JSON.stringify(DEFAULT_TEST_DATA, null, 2)
  );
  const [statusLines, setStatusLines] = useState<StatusLine[]>([
    {
      text: 'Ready to validate',
      className: 'status-neutral'
    }
  ]);
  const [result, setResult] = useState<string>('');
  const [isValidating, setIsValidating] = useState(false);
  const [isCodeViewerOpen, setIsCodeViewerOpen] = useState(false);

  const handleValidate = async () => {
    const trimmedSchema = schemaCode.trim();
    const trimmedTestData = testData.trim();

    if (!trimmedSchema) {
      setStatusLines([
        {
          text: 'Error: Schema code is empty',
          className: 'status-error'
        }
      ]);
      return;
    }

    if (!trimmedTestData) {
      setStatusLines([
        {
          text: 'Error: Test data is empty',
          className: 'status-error'
        }
      ]);
      return;
    }

    let parsedTestData: unknown;
    try {
      parsedTestData = JSON.parse(trimmedTestData);
    } catch (error) {
      setStatusLines([
        {
          text: `Error: Invalid JSON - ${error instanceof Error ? error.message : String(error)}`,
          className: 'status-error'
        }
      ]);
      return;
    }

    setIsValidating(true);
    // Don't clear result - keep it visible but dimmed during revalidation
    setStatusLines([{ text: 'Validating...', className: 'status-info' }]);

    try {
      const sessionId = getSessionId();
      const response = await fetch('/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({
          schemaCode: trimmedSchema,
          testData: parsedTestData
        })
      });

      const data = (await response.json()) as ValidateResponse | ErrorResponse;

      if (!response.ok) {
        const errorData = data as ErrorResponse;
        setStatusLines([
          {
            text: `Error: ${errorData.error}`,
            className: 'status-error'
          }
        ]);
        if (errorData.details) {
          setResult(errorData.details);
        }
        return;
      }

      const validationData = data as ValidateResponse;
      const newStatusLines: StatusLine[] = [];

      if (validationData.compiled) {
        newStatusLines.push({
          text: `Sandbox SDK: esbuild bundle (${validationData.timings.bundle}ms)`,
          className: 'status-info'
        });
      } else {
        newStatusLines.push({
          text: 'Using cached bundle (0ms)',
          className: 'status-neutral'
        });
      }

      newStatusLines.push({
        text: `Dynamic Worker: Load (${validationData.timings.load}ms)`,
        className: 'status-info'
      });

      newStatusLines.push({
        text: `Dynamic Worker: Execute (${validationData.timings.execute}ms)`,
        className: 'status-info'
      });

      if (validationData.result.success) {
        newStatusLines.push({
          text: 'Valid!',
          className: 'status-success'
        });
      } else {
        newStatusLines.push({
          text: 'Validation failed',
          className: 'status-error'
        });
      }

      setStatusLines(newStatusLines);
      setResult(JSON.stringify(validationData.result, null, 2));
    } catch (error) {
      setStatusLines([
        {
          text: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
          className: 'status-error'
        }
      ]);
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bg-cream relative">
      <header className="bg-bg-cream border-b border-border-beige shadow-sm relative z-10">
        <div className="px-6 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-orange-primary mb-1">
              TypeScript Validator
            </h1>
            <p className="text-sm font-bold text-text-dark">
              Sandbox SDK compiles a real Worker with npm dependencies → Dynamic
              Workers execute it instantly
            </p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setIsCodeViewerOpen(true)}
              className="bg-bg-cream hover:bg-bg-cream-dark text-text-dark border border-border-beige px-6 py-3 rounded-full font-medium text-sm transition-all duration-200 active:scale-[0.98]"
            >
              View Code
            </button>
            <button
              type="button"
              onClick={handleValidate}
              disabled={isValidating}
              className="bg-orange-primary hover:border-dashed disabled:bg-border-light disabled:cursor-not-allowed text-bg-cream border border-orange-primary px-6 py-3 rounded-full font-medium text-sm transition-all duration-200 active:scale-[0.98]"
            >
              {isValidating ? 'Validating...' : 'Validate'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden relative">
        <SchemaEditor value={schemaCode} onChange={setSchemaCode} />
        <TestDataPanel
          value={testData}
          onChange={setTestData}
          result={result}
          isValidating={isValidating}
        />
        {/* Corner squares at the top center where panels meet */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 pointer-events-none">
          <CornerSquares />
        </div>
        {/* Corner squares at the bottom center where panels meet footer */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 pointer-events-none">
          <CornerSquares />
        </div>
      </main>

      <footer className="bg-bg-cream border-t border-border-beige relative z-10">
        <FlowDiagram statusLines={statusLines} />
      </footer>

      <CodeViewerSheet
        isOpen={isCodeViewerOpen}
        onClose={() => setIsCodeViewerOpen(false)}
      />
    </div>
  );
}
