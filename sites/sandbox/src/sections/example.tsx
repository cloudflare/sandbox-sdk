'use client';
import { useMemo, useState } from 'react';
import {
  nodeExample,
  code,
  exposeExample,
  processingExample,
  filesExample,
  websocketExample
} from '../code-sample';
import { CodeBlock, GridBox, StripeBox } from '../components/grid';
import { TextShadow } from '../components/text-shadow';

type ExampleType =
  | 'files'
  | 'dev'
  | 'preview'
  | 'server'
  | 'interpreter'
  | 'websocket';
export function Examples() {
  const [example, setExample] = useState<ExampleType>('files');
  const exampleCode = useMemo(() => {
    switch (example) {
      case 'files':
        return filesExample;
      case 'dev':
        return code;
      case 'preview':
        return exposeExample;
      case 'server':
        return nodeExample;
      case 'interpreter':
        return processingExample;
      case 'websocket':
        return websocketExample;
      default:
        return filesExample;
    }
  }, [example]);
  return (
    <div className="lg:grid lg:grid-cols-8 lg:border-l lg:auto-rows-fr flex flex-col lg:block">
      {/* Desktop decorative grid cells */}
      {Array.from({ length: 15 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: <explanation>
        <div
          key={index}
          className="hidden lg:block border-r border-b aspect-square"
        />
      ))}

      {/* Mobile: Section title */}
      <div className="lg:hidden border p-6 flex items-center justify-center">
        <h2 className="text-6xl sm:text-7xl font-medium">
          <TextShadow text="Examples" count={3} gap="-0.6em" />
        </h2>
      </div>
      {/* Desktop: Large title */}
      <GridBox
        x={2}
        width={4}
        className="hidden lg:flex overflow-hidden items-end justify-center"
      >
        <p className="text-[120px] font-medium translate-y-2">
          <TextShadow text="Examples" count={5} gap="-0.6em" />
        </p>
      </GridBox>

      {/* Mobile: Example selector */}
      <div className="lg:hidden border border-t-0 divide-y">
        <button
          type="button"
          className={`w-full text-left text-base sm:text-lg p-4 transition-colors flex items-center justify-between ${example === 'files' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('files')}
        >
          <span>File Operations</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          className={`w-full text-left text-base sm:text-lg p-4 transition-colors flex items-center justify-between ${example === 'dev' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('dev')}
        >
          <span>Interactive development environment</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          className={`w-full text-left text-base sm:text-lg p-4 transition-colors flex items-center justify-between ${example === 'preview' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('preview')}
        >
          <span>Expose services with preview URLs</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          className={`w-full text-left text-base sm:text-lg p-4 transition-colors flex items-center justify-between ${example === 'server' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('server')}
        >
          <span>Run a Node.js app</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          className={`w-full text-left text-base sm:text-lg p-4 transition-colors flex items-center justify-between ${example === 'interpreter' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('interpreter')}
        >
          <span>Code Interpreter</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          className={`w-full text-left text-base sm:text-lg p-4 transition-colors flex items-center justify-between ${example === 'websocket' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('websocket')}
        >
          <span>WebSocket Connections</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="h-32 overflow-hidden">
          <StripeBox />
        </div>
      </div>

      {/* Mobile: Code block */}
      <div className="lg:hidden border border-t-0 overflow-x-auto">
        <CodeBlock>{exampleCode}</CodeBlock>
      </div>

      {/* Desktop: Example selector */}
      <GridBox x={1} y={1} width={2} className="hidden lg:grid grid-rows-2">
        <p
          className={`text-lg flex leading-tight items-center justify-between px-6 border-b cursor-pointer transition-colors ${example === 'files' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('files')}
        >
          <span>File Operations</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </p>
        <p
          className={`text-lg flex leading-tight items-center justify-between px-6 cursor-pointer transition-colors ${example === 'dev' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('dev')}
        >
          <span>Interactive development environment</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </p>
      </GridBox>
      <GridBox x={1} y={2} width={2} className="hidden lg:grid grid-rows-2">
        <p
          className={`text-lg flex leading-tight items-center justify-between px-6 border-b cursor-pointer transition-colors ${example === 'preview' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('preview')}
        >
          <span>Expose services with preview URLs</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </p>
        <p
          className={`text-lg flex leading-tight items-center justify-between px-6 cursor-pointer transition-colors ${example === 'server' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('server')}
        >
          <span>Run a Node.js app</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </p>
      </GridBox>
      <GridBox x={1} y={3} width={2} className="hidden lg:grid grid-rows-2">
        <p
          className={`text-lg flex leading-tight items-center justify-between px-6 border-b cursor-pointer transition-colors ${example === 'interpreter' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('interpreter')}
        >
          <span>Code interpreter</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </p>
        <p
          className={`text-lg flex leading-tight items-center justify-between px-6 border-b cursor-pointer transition-colors ${example === 'websocket' ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          onClick={() => setExample('websocket')}
        >
          <span>WebSocket connections</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </p>
      </GridBox>
      <GridBox x={1} y={4} width={2} className="hidden lg:grid grid-rows-1">
        <div className="h-full overflow-hidden">
          <StripeBox />
        </div>
      </GridBox>

      {/* Desktop: Code block */}
      <GridBox x={3} y={1} width={4} height={4} className="hidden lg:block">
        <CodeBlock>{exampleCode}</CodeBlock>
      </GridBox>
    </div>
  );
}
