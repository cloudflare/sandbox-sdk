import { useRef } from 'react';
import { DesktopViewer } from './components/DesktopViewer';
import { Header } from './components/Header';
import { useDesktop } from './hooks/useDesktop';

export default function App() {
  const { isRunning, isStarting, streamUrl, error, start, stop } = useDesktop();
  const viewerRef = useRef<HTMLElement>(null);

  const handleStart = () => {
    const el = viewerRef.current;
    if (el) {
      // Measure the available space and start the desktop at that resolution
      start([el.clientWidth, el.clientHeight]);
    } else {
      start();
    }
  };

  return (
    <div className="flex flex-col h-screen">
      <Header
        isRunning={isRunning}
        isStarting={isStarting}
        onStart={handleStart}
        onStop={stop}
      />

      {error && (
        <div className="px-4 py-2 bg-red-950 text-red-300 text-sm border-b border-red-800">
          {error}
        </div>
      )}

      <main ref={viewerRef} className="flex-1 flex overflow-hidden bg-black">
        <DesktopViewer
          isRunning={isRunning}
          isStarting={isStarting}
          streamUrl={streamUrl}
        />
      </main>
    </div>
  );
}
