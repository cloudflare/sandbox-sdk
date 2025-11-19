/** biome-ignore-all lint/suspicious/noArrayIndexKey: it's fine */
'use client';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { pythonExample } from '../code-sample';
import { File } from '../components/file';
import { DotBox, GridBox } from '../components/grid';
import { TextShadow } from '../components/text-shadow';

export function Features() {
  return (
    <div className="lg:grid lg:grid-cols-8 lg:border-l lg:auto-rows-fr flex flex-col lg:block">
      {/* Desktop decorative grid cells */}
      {Array.from({ length: 18 }).map((_, index) => (
        <div
          key={index}
          className="hidden lg:block border-r border-b aspect-square"
        />
      ))}

      {/* Mobile: Section title */}
      <div className="lg:hidden border p-6 flex items-center justify-center">
        <h2 className="text-6xl sm:text-7xl font-medium">
          <TextShadow text="Features" count={3} gap="-0.6em" />
        </h2>
      </div>
      {/* Desktop: Large title */}
      <GridBox
        x={2}
        width={4}
        className="hidden lg:flex overflow-hidden items-end justify-center"
      >
        <p className="text-[120px] font-medium translate-y-2">
          <TextShadow text="Features" count={5} gap="-0.6em" />
        </p>
      </GridBox>
      {/* Feature 1: Long-running processes */}
      <div className="lg:hidden border border-t-0">
        <FeatureSectionMobile title="Long-running processes">
          <p>
            Safely execute tasks that require extended computation or monitoring
            without risking system stability or security.
          </p>
        </FeatureSectionMobile>
      </div>

      <FeatureSection
        x={1}
        y={1}
        title="Long-running processes"
        className="hidden lg:flex"
      >
        <p>
          Safely execute tasks that require extended computation or monitoring
          without risking system stability or security.
        </p>
      </FeatureSection>
      <GridBox x={4} y={1} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full flex items-center gap-8">
            <div className="bg-background w-full h-full flex items-center justify-center gap-2 border border-b-0 text-2xl font-mono overflow-hidden">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                width="32"
                className="animate-spin"
                strokeWidth="4"
              >
                <title>Processing</title>
                <path
                  d="M20.5 12C20.5 16.6944 16.6944 20.5 12 20.5C7.30558 20.5 3.5 16.6944 3.5 12C3.5 7.30558 7.30558 3.5 12 3.5C16.6944 3.5 20.5 7.30558 20.5 12Z"
                  stroke="black"
                  strokeOpacity="0.2"
                />
                <path
                  d="M20.3681 13.5C19.7463 16.9921 16.9921 19.7463 13.5 20.3681"
                  stroke="black"
                  strokeLinecap="round"
                />
              </svg>
              <p className="-translate-y-px">processing...</p>
            </div>
            <div className="rounded-full bg-background w-24 h-24 items-center justify-center flex border shrink-0">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fillRule="evenodd"
                clipRule="evenodd"
                fill="currentColor"
                width="48"
              >
                <title>Processing</title>
                <path d="M12 2C12.5523 2 13 2.44772 13 3V4C13 4.55228 12.5523 5 12 5C11.4477 5 11 4.55228 11 4V3C11 2.44772 11.4477 2 12 2ZM2 12C2 11.4477 2.44772 11 3 11H4C4.55228 11 5 11.4477 5 12C5 12.5523 4.55228 13 4 13H3C2.44772 13 2 12.5523 2 12ZM19 12C19 11.4477 19.4477 11 20 11H21C21.5523 11 22 11.4477 22 12C22 12.5523 21.5523 13 21 13H20C19.4477 13 19 12.5523 19 12Z" />
                <path d="M16.9491 7.05025C16.5586 6.65973 16.5586 6.02656 16.9491 5.63604L17.6562 4.92893C18.0468 4.53841 18.6799 4.53841 19.0705 4.92893C19.461 5.31946 19.461 5.95262 19.0705 6.34315L18.3634 7.05025C17.9728 7.44078 17.3397 7.44078 16.9491 7.05025Z" />
                <path d="M2 16C2 15.4477 2.44772 15 3 15H21C21.5523 15 22 15.4477 22 16C22 16.5523 21.5523 17 21 17H3C2.44772 17 2 16.5523 2 16ZM6 20C6 19.4477 6.44772 19 7 19H17C17.5523 19 18 19.4477 18 20C18 20.5523 17.5523 21 17 21H7C6.44772 21 6 20.5523 6 20Z" />
                <path d="M4.92961 4.92893C5.32014 4.53841 5.9533 4.53841 6.34383 4.92893L7.05093 5.63604C7.44146 6.02656 7.44146 6.65973 7.05093 7.05025C6.66041 7.44078 6.02724 7.44078 5.63672 7.05025L4.92961 6.34315C4.53909 5.95262 4.53909 5.31946 4.92961 4.92893Z" />
                <path d="M8 13C7.44772 13 7 12.5523 7 12C7 9.23858 9.23858 7 12 7C14.7614 7 17 9.23858 17 12C17 12.5523 16.5523 13 16 13C14.3023 13 9.6977 13 8 13Z" />
              </svg>
            </div>
          </div>
        </DotBox>
      </GridBox>

      {/* Feature 2: Real time streaming */}
      <div className="lg:hidden border border-t-0">
        <FeatureSectionMobile title="Real time streaming">
          <p>
            Listen to standard output & error streams live when executing
            long-running commands
          </p>
        </FeatureSectionMobile>
      </div>

      <FeatureSection
        x={4}
        y={2}
        title="Real time streaming"
        className="hidden lg:flex"
      >
        <p>
          Listen to standard output & error streams live when executing
          long-running commands
        </p>
      </FeatureSection>
      <GridBox x={1} y={2} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative px-8 h-full w-full flex items-center">
            <div className="border bg-background h-16 w-16 flex items-center justify-center rounded-full shrink-0">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                width="32"
              >
                <title>Real time streaming</title>
                <path d="M14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 10.3085 11.4892 11.7424 10.6158 12.6158C9.74243 13.4892 8.30849 14 6 14C5.44772 14 5 14.4477 5 15C5 15.5523 5.44772 16 6 16C8.30849 16 9.74243 16.5108 10.6158 17.3842C11.4892 18.2576 12 19.6915 12 22C12 22.5523 12.4477 23 13 23C13.5523 23 14 22.5523 14 22C14 19.6915 14.5108 18.2576 15.3842 17.3842C16.2576 16.5108 17.6915 16 20 16C20.5523 16 21 15.5523 21 15C21 14.4477 20.5523 14 20 14C17.6915 14 16.2576 13.4892 15.3842 12.6158C14.5108 11.7424 14 10.3085 14 8Z" />
                <path d="M6 5.5C6 5.22386 5.77614 5 5.5 5C5.22386 5 5 5.22386 5 5.5C5 6.48063 4.78279 7.0726 4.4277 7.4277C4.0726 7.78279 3.48063 8 2.5 8C2.22386 8 2 8.22386 2 8.5C2 8.77614 2.22386 9 2.5 9C3.48063 9 4.0726 9.21721 4.4277 9.5723C4.78279 9.9274 5 10.5194 5 11.5C5 11.7761 5.22386 12 5.5 12C5.77614 12 6 11.7761 6 11.5C6 10.5194 6.21721 9.9274 6.5723 9.5723C6.9274 9.21721 7.51937 9 8.5 9C8.77614 9 9 8.77614 9 8.5C9 8.22386 8.77614 8 8.5 8C7.51937 8 6.9274 7.78279 6.5723 7.4277C6.21721 7.0726 6 6.48063 6 5.5Z" />
                <path d="M11 1.5C11 1.22386 10.7761 1 10.5 1C10.2239 1 10 1.22386 10 1.5C10 2.13341 9.85918 2.47538 9.66728 2.66728C9.47538 2.85918 9.13341 3 8.5 3C8.22386 3 8 3.22386 8 3.5C8 3.77614 8.22386 4 8.5 4C9.13341 4 9.47538 4.14082 9.66728 4.33272C9.85918 4.52462 10 4.86659 10 5.5C10 5.77614 10.2239 6 10.5 6C10.7761 6 11 5.77614 11 5.5C11 4.86659 11.1408 4.52462 11.3327 4.33272C11.5246 4.14082 11.8666 4 12.5 4C12.7761 4 13 3.77614 13 3.5C13 3.22386 12.7761 3 12.5 3C11.8666 3 11.5246 2.85918 11.3327 2.66728C11.1408 2.47538 11 2.13341 11 1.5Z" />
              </svg>
            </div>
            <div className="w-16 relative flex items-center shrink-0">
              <div className="size-5 rounded-full border bg-background flex items-center justify-center -ml-2.5 relative">
                <div className="size-3 rounded-full bg-foreground"></div>
              </div>
              <div
                className="tube-bar h-2 bg-foreground grow -mx-2.5 rounded-full"
                style={
                  {
                    '--tube-delay': '-0.3s',
                    '--tube-duration': '0.7s'
                  } as CSSProperties
                }
              />
              <div className="size-5 rounded-full border bg-background flex items-center justify-center -mr-2.5">
                <div className="size-3 rounded-full bg-foreground"></div>
              </div>
            </div>
            <div className="h-full flex flex-col pt-8">
              <div className="bg-background grow border border-b-0">
                <div className="h-6 border-b" />
                <div className="font-mono py-4 px-5 relative overflow-hidden">
                  <span className="invisible">
                    Sure thing! I can guide you through implementing the issue
                    and opening a pull request. First, I need some details:
                  </span>
                  <span className="absolute top-4 left-5">
                    <StreamingText text="Sure thing! I can guide you through implementing the issue and opening a pull request. First, I need some details:" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </DotBox>
      </GridBox>
      {/* <FeatureSection title="Session management" y={3} x={1}>
        <p>
          Safely execute tasks that require extended computation or monitoring
          without risking system stability or security.
        </p>
      </FeatureSection>
      <GridBox x={4} y={3} width={3}>
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full">
            <div className="relative bg-background w-full h-full border border-b-0 overflow-hidden">
              <div className="h-6 border-b" />
              <div className="font-mono p-4 overflow-hidden">
                $ git clone https://github.com/cloudflare/agents
              </div>
            </div>
          </div>
        </DotBox>
      </GridBox> */}
      {/* Feature 3: Preview URLs */}
      <div className="lg:hidden border border-t-0">
        <FeatureSectionMobile title="Preview URLs">
          <p>
            Instantly expose any container port as a public URL with automatic
            subdomain routing
          </p>
        </FeatureSectionMobile>
      </div>

      <FeatureSection
        title="Preview URLs"
        y={3}
        x={1}
        className="hidden lg:flex"
      >
        <p>
          Instantly expose any container port as a public URL with automatic
          subdomain routing
        </p>
      </FeatureSection>
      <GridBox x={4} y={3} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full">
            <div className="relative w-full h-full flex flex-col">
              <div className="h-4 border border-b-0 mx-8 bg-background flex items-center px-2 font-mono text-[8px]">
                <p>Preview 3</p>
              </div>
              <div className="h-4 border border-b-0 mx-4 bg-background flex items-center px-2 font-mono text-[10px]">
                <p>Preview 2</p>
              </div>
              <div className="h-6 border bg-background flex items-center px-2 font-mono text-[12px]">
                <p>Preview 1</p>
              </div>
              <div className="p-4 text-xl font-medium flex items-center justify-center grow border-x bg-background">
                Hello world!
              </div>
            </div>
          </div>
        </DotBox>
      </GridBox>

      {/* Feature 4: Code interpreter */}
      <div className="lg:hidden border border-t-0">
        <FeatureSectionMobile title="Code interpreter">
          <p>
            Run Python/JavaScript code directly, with rich outputs (charts,
            tables, images) parsed automatically for you
          </p>
        </FeatureSectionMobile>
      </div>

      <FeatureSection
        title="Code interpreter"
        y={4}
        x={4}
        className="hidden lg:flex"
      >
        <p>
          Run Python/JavaScript code directly, with rich outputs (charts,
          tables, images) parsed automatically for you
        </p>
      </FeatureSection>
      <GridBox x={1} y={4} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full">
            <div className="relative bg-background w-full h-full border border-b-0 overflow-hidden">
              <div className="h-6 border-b flex items-center px-4 font-mono text-sm">
                <p>app.py</p>
              </div>
              <div
                className="p-4"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: pythonExample is safe
                dangerouslySetInnerHTML={{ __html: pythonExample }}
              />
            </div>
          </div>
        </DotBox>
      </GridBox>

      {/* Feature 5: File system */}
      <div className="lg:hidden border border-t-0">
        <FeatureSectionMobile title="File system">
          <p>
            Easy methods for basic filesystem operations and cloning git
            repositories on the container filesystem
          </p>
        </FeatureSectionMobile>
      </div>

      <FeatureSection
        title="File system"
        y={5}
        x={1}
        className="hidden lg:flex"
      >
        <p>
          Easy methods for basic filesystem operations and cloning git
          repositories on the container filesystem
        </p>
      </FeatureSection>
      <GridBox x={4} y={5} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full">
            <div className="relative bg-background w-full h-full border border-b-0 flex justify-between items-center px-8">
              {Array.from({ length: 5 }).map((_, i) => {
                return <File key={i} />;
              })}
            </div>
          </div>
        </DotBox>
      </GridBox>

      {/* Feature 6: Command execution */}
      <div className="lg:hidden border border-t-0">
        <FeatureSectionMobile title="Command execution">
          <p>
            Run any shell command with proper exit codes, streaming, and error
            handling
          </p>
        </FeatureSectionMobile>
      </div>

      <FeatureSection
        title="Command execution"
        y={6}
        x={4}
        className="hidden lg:flex"
      >
        <p>
          Run any shell command with proper exit codes, streaming, and error
          handling
        </p>
      </FeatureSection>
      <GridBox x={1} y={6} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full">
            <div className="relative bg-background w-full h-full border border-b-0 overflow-hidden">
              <div className="h-6 border-b" />
              <div className="font-mono p-4 overflow-hidden">
                $ git clone https://github.com/cloudflare/agents
              </div>
            </div>
          </div>
        </DotBox>
      </GridBox>

      {/* Feature 7: WebSockets */}
      <div className="lg:hidden border border-t-0">
        <FeatureSectionMobile title="WebSockets">
          <p>
            Enable real-time, bidirectional communication by connecting directly
            to WebSocket servers running in the sandbox
          </p>
        </FeatureSectionMobile>
      </div>

      <FeatureSection title="WebSockets" y={7} x={1} className="hidden lg:flex">
        <p>
          Enable real-time, bidirectional communication by connecting directly
          to WebSocket servers running in the sandbox
        </p>
      </FeatureSection>
      <GridBox x={4} y={7} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full flex items-center justify-center gap-4">
            <div className="flex flex-col items-center gap-2">
              <div className="border bg-background rounded-full size-16 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  width="32"
                >
                  <title>Worker</title>
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
              </div>
              <p className="text-xs font-mono">Worker</p>
            </div>
            <div className="flex flex-col gap-2 items-center">
              <div className="flex gap-1">
                <div
                  className="w-2 h-2 rounded-full bg-foreground animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-foreground animate-bounce"
                  style={{ animationDelay: '150ms' }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-foreground animate-bounce"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="24"
                className="rotate-90"
              >
                <title>WebSockets</title>
                <path d="M8 3 4 7l4 4" />
                <path d="M4 7h16" />
                <path d="m16 21 4-4-4-4" />
                <path d="M20 17H4" />
              </svg>
              <div className="flex gap-1">
                <div
                  className="w-2 h-2 rounded-full bg-foreground animate-bounce"
                  style={{ animationDelay: '450ms' }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-foreground animate-bounce"
                  style={{ animationDelay: '600ms' }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-foreground animate-bounce"
                  style={{ animationDelay: '750ms' }}
                />
              </div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="border bg-background rounded-full size-16 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  width="32"
                >
                  <title>Sandbox</title>
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="3.29 7 12 12 20.71 7" />
                  <line x1="12" y1="22" x2="12" y2="12" />
                </svg>
              </div>
              <p className="text-xs font-mono">Sandbox</p>
            </div>
          </div>
        </DotBox>
      </GridBox>
    </div>
  );
}

function FeatureSection({
  x,
  y,
  title,
  children,
  className
}: {
  x?: number;
  y?: number;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <GridBox
      className={`flex items-center justify-center px-8 ${className || ''}`}
      x={x}
      y={y}
      width={3}
    >
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
      </section>
    </GridBox>
  );
}

function FeatureSectionMobile({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="p-6 space-y-2">
      <h3 className="text-xl font-semibold">{title}</h3>
      <div className="text-sm text-foreground/80">{children}</div>
    </section>
  );
}

function StreamingText({ text }: { text: string }) {
  const [displayedText, setDisplayedText] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (currentIndex < text.length) {
      const timeout = setTimeout(() => {
        setDisplayedText(text.slice(0, currentIndex + 1));
        setCurrentIndex(currentIndex + 1);
      }, 30); // Adjust speed here (lower = faster)

      return () => clearTimeout(timeout);
    } else {
      // Wait 2 seconds after completion, then restart
      const restartTimeout = setTimeout(() => {
        setDisplayedText('');
        setCurrentIndex(0);
      }, 3000);

      return () => clearTimeout(restartTimeout);
    }
  }, [currentIndex, text]);

  return (
    <span>
      {displayedText}
      {currentIndex < text.length && (
        <span className="inline-block w-2 h-4 bg-foreground ml-0.5 animate-pulse" />
      )}
    </span>
  );
}
