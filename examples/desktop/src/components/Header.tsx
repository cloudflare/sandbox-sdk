import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Camera } from '@phosphor-icons/react';

interface HeaderProps {
  isRunning: boolean;
  isStarting: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function Header({
  isRunning,
  isStarting,
  onStart,
  onStop
}: HeaderProps) {
  return (
    <header className="flex justify-between items-center px-4 py-3 bg-gray-950 border-b border-gray-800">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-gray-100">
          Desktop Environment
        </h1>
        <Badge
          variant={
            isStarting ? 'secondary' : isRunning ? 'primary' : 'secondary'
          }
        >
          {isStarting ? 'Starting…' : isRunning ? 'Running' : 'Stopped'}
        </Badge>
      </div>
      <div className="flex gap-2">
        {isRunning && (
          <Button
            variant="outline"
            icon={Camera}
            onClick={() => window.open('/api/screenshot', '_blank')}
          >
            Screenshot
          </Button>
        )}
        {isRunning ? (
          <Button variant="destructive" onClick={onStop}>
            Stop Desktop
          </Button>
        ) : (
          <Button variant="primary" onClick={onStart} disabled={isStarting}>
            {isStarting ? 'Starting…' : 'Start Desktop'}
          </Button>
        )}
      </div>
    </header>
  );
}
