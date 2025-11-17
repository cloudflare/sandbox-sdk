import { useMemo } from 'react';
import DottedBackground from './DottedBackground';
import type { StatusLine } from '../types';

interface FlowDiagramProps {
  statusLines: StatusLine[];
}

type FlowState =
  | 'idle'
  | 'compiling'
  | 'cached'
  | 'executing'
  | 'success'
  | 'error';

interface Timings {
  install?: number;
  bundle?: number;
  load?: number;
  execute?: number;
}

export default function FlowDiagram({ statusLines }: FlowDiagramProps) {
  // Determine current flow state from status lines
  const flowState: FlowState = useMemo(() => {
    if (statusLines.length === 0) return 'idle';

    const lastLine = statusLines[statusLines.length - 1];

    if (lastLine.text.includes('Ready to validate')) return 'idle';
    if (lastLine.text.includes('Validating')) return 'compiling';
    if (
      lastLine.text.includes('npm install') ||
      lastLine.text.includes('esbuild')
    )
      return 'compiling';
    if (lastLine.text.includes('cached bundle')) return 'cached';
    if (lastLine.text.includes('Dynamic Worker')) return 'executing';
    if (lastLine.text.includes('Valid!')) return 'success';
    if (lastLine.text.includes('failed') || lastLine.text.includes('Error'))
      return 'error';

    return 'idle';
  }, [statusLines]);

  // Extract timing information from status lines
  const timings: Timings = useMemo(() => {
    const result: Timings = {};

    statusLines.forEach((line) => {
      const installMatch = line.text.match(/npm install.*?\((\d+)ms\)/);
      const bundleMatch = line.text.match(/esbuild bundle.*?\((\d+)ms\)/);
      const loadMatch = line.text.match(/Load.*?\((\d+)ms\)/);
      const executeMatch = line.text.match(/Execute.*?\((\d+)ms\)/);

      if (installMatch) result.install = parseInt(installMatch[1], 10);
      if (bundleMatch) result.bundle = parseInt(bundleMatch[1], 10);
      if (loadMatch) result.load = parseInt(loadMatch[1], 10);
      if (executeMatch) result.execute = parseInt(executeMatch[1], 10);
    });

    return result;
  }, [statusLines]);

  const isCompiling = flowState === 'compiling';
  const isCached = flowState === 'cached';
  const isExecuting =
    flowState === 'executing' ||
    flowState === 'success' ||
    flowState === 'error';
  const showResult = flowState === 'success' || flowState === 'error';

  // Check if we ever used cached bundle (not just current state)
  const usedCachedBundle = statusLines.some((line) =>
    line.text.includes('cached bundle')
  );

  // Animation logic: "everything that is DONE is animating"
  const isInitialIdle =
    flowState === 'idle' &&
    statusLines.some((line) => line.text.includes('Ready to validate'));

  // Node completion states
  const schemaNodeDone = !isInitialIdle;
  const sandboxNodeDone = isCached || isExecuting || showResult;
  const workerNodeDone = showResult;
  const resultNodeDone = showResult;

  // Edge 1 (Schema → Sandbox): Animates once we've started any work (schema is done/ready)
  const animateEdge1 = schemaNodeDone;
  // Edge 2 (Sandbox → Dynamic Worker): Animates when compilation is done (cached, executing, or result)
  const animateEdge2 = sandboxNodeDone;
  // Edge 3 (Dynamic Worker → Result): Animates when execution is done (result ready)
  const animateEdge3 = workerNodeDone;

  // Status text based on current flow state
  const getStatusText = () => {
    switch (flowState) {
      case 'idle':
        return isInitialIdle
          ? 'Ready to validate your schema'
          : 'Ready for next validation';
      case 'compiling':
        return 'Compiling schema validator with Sandbox SDK';
      case 'cached':
        return 'Using cached bundle (instant execution)';
      case 'executing':
        return 'Executing code in Dynamic Worker';
      case 'success':
        return 'Validation successful!';
      case 'error':
        return 'Validation failed';
      default:
        return '';
    }
  };

  return (
    <div className="px-6 py-8 border-b border-border-beige bg-bg-cream-dark relative overflow-hidden">
      <DottedBackground />
      <div className="flex items-center justify-center gap-0 relative z-10">
        {/* Schema Node */}
        <div className="flex flex-col items-center">
          <div
            className={`w-24 h-24 rounded-sm border-2 border-dashed flex flex-col items-center justify-center gap-1 transition-all duration-300 ${schemaNodeDone ? 'border-text-dark bg-[#5210000d]' : 'border-border-beige bg-bg-cream'}`}
          >
            <svg className="w-8 h-8" viewBox="0 0 25 24" fill="none">
              <title>Schema</title>
              <path
                d="M9.87182 18.3256L5.14774 12.0072L9.84586 5.86857L8.93876 4.63086L3.64504 11.5551L3.6377 12.4407L8.95688 19.5633L9.87182 18.3256Z"
                fill="currentColor"
                className={
                  schemaNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
              <path
                d="M11.5208 3.18359H9.70264L16.2595 12.1469L9.85692 20.8162H11.6863L18.0855 12.1503L11.5208 3.18359Z"
                fill="currentColor"
                className={
                  schemaNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
              <path
                d="M15.0365 3.18359H13.1958L19.856 12.0401L13.1958 20.8162H15.0399L21.3622 12.4848V11.5993L15.0365 3.18359Z"
                fill="currentColor"
                className={
                  schemaNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
            </svg>
            <span
              className={`text-[10px] font-medium ${schemaNodeDone ? 'text-text-dark' : 'text-text-medium'}`}
            >
              Schema
            </span>
          </div>
        </div>

        {/* Connection 1: Schema → Sandbox */}
        <div className="relative w-20 h-1 mx-2">
          {timings.install || timings.bundle ? (
            <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-medium text-text-medium whitespace-nowrap">
              {timings.install && timings.bundle
                ? `${timings.install + timings.bundle}ms`
                : timings.install
                  ? `${timings.install}ms`
                  : `${timings.bundle}ms`}
            </div>
          ) : (
            usedCachedBundle && (
              <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-medium text-text-medium whitespace-nowrap">
                0ms
              </div>
            )
          )}
          <svg
            className="absolute inset-0 w-full h-full"
            preserveAspectRatio="none"
          >
            <title>Connection</title>
            <line
              x1="0"
              y1="50%"
              x2="100%"
              y2="50%"
              stroke={animateEdge1 ? '#521000' : '#ebd5c1'}
              strokeWidth="2"
              strokeDasharray="5,5"
              className={animateEdge1 ? 'animate-march' : ''}
            />
          </svg>
        </div>

        {/* Sandbox Node */}
        <div className="flex flex-col items-center relative">
          {isCached && (
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-[#19e306] text-bg-cream text-[9px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap">
              Cached ⚡
            </div>
          )}
          <div
            className={`w-24 h-24 rounded-sm border-2 border-dashed flex flex-col items-center justify-center gap-1 transition-all duration-300 ${sandboxNodeDone ? 'border-text-dark bg-[#5210000d]' : 'border-border-beige bg-bg-cream'}`}
          >
            <svg className="w-8 h-8" viewBox="0 0 25 24" fill="none">
              <title>Sandbox SDK</title>
              <path
                d="M21.5 16.0018V7.99739C21.4997 7.73541 21.4308 7.47807 21.3001 7.25101C21.1694 7.02394 20.9815 6.83506 20.7552 6.70317L13.6302 2.55661C13.2869 2.35675 12.8968 2.25146 12.4995 2.25146C12.1023 2.25146 11.7122 2.35675 11.3689 2.55661L4.24484 6.70317C4.01848 6.83506 3.83061 7.02394 3.69993 7.25101C3.56925 7.47807 3.50032 7.73541 3.5 7.99739V16.0018C3.50016 16.2639 3.56901 16.5214 3.6997 16.7487C3.83038 16.9759 4.01834 17.1649 4.24484 17.2969L11.3698 21.4435C11.7132 21.6431 12.1033 21.7482 12.5005 21.7482C12.8976 21.7482 13.2877 21.6431 13.6311 21.4435L20.7561 17.2969C20.9824 17.1648 21.1702 16.9758 21.3007 16.7485C21.4312 16.5213 21.4999 16.2638 21.5 16.0018Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={
                  sandboxNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
              <path
                d="M3.73438 7.21826L12.5 12.3745M12.5 12.3745L21.2656 7.21826M12.5 12.3745V21.7495"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={
                  sandboxNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
            </svg>
            <span
              className={`text-[10px] font-medium text-center ${sandboxNodeDone ? 'text-text-dark' : 'text-text-medium'}`}
            >
              Sandbox SDK
            </span>
          </div>
        </div>

        {/* Connection 2: Sandbox → Dynamic Worker */}
        <div className="relative w-20 h-1 mx-2">
          {timings.load !== undefined && (
            <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-medium text-text-medium whitespace-nowrap">
              {timings.load}ms
            </div>
          )}
          <svg
            className="absolute inset-0 w-full h-full"
            preserveAspectRatio="none"
          >
            <title>Connection</title>
            <line
              x1="0"
              y1="50%"
              x2="100%"
              y2="50%"
              stroke={animateEdge2 ? '#521000' : '#ebd5c1'}
              strokeWidth="2"
              strokeDasharray="5,5"
              className={animateEdge2 ? 'animate-march' : ''}
            />
          </svg>
        </div>

        {/* Dynamic Worker Node */}
        <div className="flex flex-col items-center">
          <div
            className={`w-24 h-24 rounded-sm border-2 border-dashed flex flex-col items-center justify-center gap-1 transition-all duration-300 ${workerNodeDone ? 'border-text-dark bg-[#5210000d]' : 'border-border-beige bg-bg-cream'}`}
          >
            <svg className="w-8 h-8" viewBox="0 0 25 24" fill="none">
              <title>Dynamic Worker</title>
              <path
                d="M9.87182 18.3256L5.14774 12.0072L9.84586 5.86857L8.93876 4.63086L3.64504 11.5551L3.6377 12.4407L8.95688 19.5633L9.87182 18.3256Z"
                fill="currentColor"
                className={
                  workerNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
              <path
                d="M11.5208 3.18359H9.70264L16.2595 12.1469L9.85692 20.8162H11.6863L18.0855 12.1503L11.5208 3.18359Z"
                fill="currentColor"
                className={
                  workerNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
              <path
                d="M15.0365 3.18359H13.1958L19.856 12.0401L13.1958 20.8162H15.0399L21.3622 12.4848V11.5993L15.0365 3.18359Z"
                fill="currentColor"
                className={
                  workerNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
            </svg>
            <span
              className={`text-[10px] font-medium text-center ${workerNodeDone ? 'text-text-dark' : 'text-text-medium'}`}
            >
              Dynamic Worker
            </span>
          </div>
        </div>

        {/* Connection 3: Dynamic Worker → Result */}
        <div className="relative w-20 h-1 mx-2">
          {timings.execute !== undefined && (
            <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-medium text-text-medium whitespace-nowrap">
              {timings.execute}ms
            </div>
          )}
          <svg
            className="absolute inset-0 w-full h-full"
            preserveAspectRatio="none"
          >
            <title>Connection</title>
            <line
              x1="0"
              y1="50%"
              x2="100%"
              y2="50%"
              stroke={animateEdge3 ? '#521000' : '#ebd5c1'}
              strokeWidth="2"
              strokeDasharray="5,5"
              className={animateEdge3 ? 'animate-march' : ''}
            />
          </svg>
        </div>

        {/* Result Node */}
        <div className="flex flex-col items-center">
          <div
            className={`w-24 h-24 rounded-sm border-2 border-dashed flex flex-col items-center justify-center gap-1 transition-all duration-300 ${resultNodeDone ? 'border-text-dark bg-[#5210000d]' : 'border-border-beige bg-bg-cream'}`}
          >
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none">
              <title>Result</title>
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeWidth="1.5"
                className={
                  resultNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
              <circle
                cx="12"
                cy="12"
                r="3"
                fill="currentColor"
                className={
                  resultNodeDone ? 'text-text-dark' : 'text-text-medium'
                }
              />
            </svg>
            <span
              className={`text-[10px] font-medium ${resultNodeDone ? 'text-text-dark' : 'text-text-medium'}`}
            >
              Result
            </span>
          </div>
        </div>
      </div>

      {/* Status Text */}
      <div className="mt-6 text-center relative z-10">
        <p className="text-sm text-text-dark">{getStatusText()}</p>
      </div>

      <style>{`
        @keyframes march {
          to {
            stroke-dashoffset: -10;
          }
        }

        .animate-march {
          animation: march 1s linear infinite;
        }

        @keyframes pulse-subtle {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.8;
          }
        }

        .animate-pulse-subtle {
          animation: pulse-subtle 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
