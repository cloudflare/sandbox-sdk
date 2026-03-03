interface DesktopViewerProps {
  isRunning: boolean;
  isStarting: boolean;
  streamUrl: string | null;
}

export function DesktopViewer({
  isRunning,
  isStarting,
  streamUrl
}: DesktopViewerProps) {
  if (isStarting) {
    return (
      <div className="w-full h-full flex justify-center items-center">
        <div className="text-center text-gray-500">
          <p>Starting desktop environment…</p>
          <p className="text-sm mt-2">This may take a few seconds</p>
        </div>
      </div>
    );
  }

  if (!isRunning) {
    return (
      <div className="w-full h-full flex justify-center items-center">
        <div className="text-center text-gray-500">
          <p>Desktop is stopped</p>
          <p className="text-sm mt-2">
            Click &quot;Start Desktop&quot; to begin
          </p>
        </div>
      </div>
    );
  }

  if (!streamUrl) {
    return (
      <div className="w-full h-full flex justify-center items-center">
        <div className="text-center text-gray-500">
          <p>Connecting…</p>
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={streamUrl}
      title="Desktop Stream"
      className="w-full h-full border-none"
      allow="clipboard-read; clipboard-write"
    />
  );
}
