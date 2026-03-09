import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useActiveRooms } from '../hooks/useActiveRooms';
import type { Route } from './+types/home';

export function meta(_args: Route.MetaArgs) {
  return [
    { title: 'Collaborative Terminal' },
    {
      name: 'description',
      content: 'Real-time terminal sharing powered by Cloudflare Sandbox'
    }
  ];
}

function getRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Home() {
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const { rooms, isLoading } = useActiveRooms();

  const createRoom = async () => {
    setIsCreating(true);
    try {
      const response = await fetch('/api/room', { method: 'POST' });
      const data = (await response.json()) as { roomId: string };
      navigate(`/room/${data.roomId}`);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="p-6">
        <div className="flex items-center gap-2 text-zinc-100">
          <TerminalIcon className="w-6 h-6 text-orange-500" />
          <span className="font-semibold">Sandbox</span>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 pb-20">
        <div className="text-center max-w-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 mb-8 text-sm text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-full">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
            Powered by Cloudflare Sandbox
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-4">
            Collaborative
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-500 to-amber-500">
              Terminal
            </span>
          </h1>

          <p className="text-lg text-zinc-400 mb-10">
            Real-time terminal sharing. Like Google Docs, but for your shell.
          </p>

          <button
            type="button"
            onClick={createRoom}
            disabled={isCreating}
            className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-medium rounded-lg hover:from-orange-600 hover:to-orange-700 disabled:opacity-50 transition-all"
          >
            <PlusIcon className="w-4 h-4" />
            {isCreating ? 'Creating...' : 'Create New Room'}
          </button>

          <div className="flex items-center justify-center gap-8 mt-10 text-sm text-zinc-500">
            <div className="flex items-center gap-2">
              <UsersIcon className="w-4 h-4" />
              Multi-user
            </div>
            <div className="flex items-center gap-2">
              <ClockIcon className="w-4 h-4" />
              Real-time sync
            </div>
            <div className="flex items-center gap-2">
              <LockIcon className="w-4 h-4" />
              Secure isolation
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="mt-12 w-full max-w-4xl mx-auto">
            <div className="flex items-center justify-center gap-2 text-sm text-zinc-500">
              <span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-pulse" />
              Checking for active rooms...
            </div>
          </div>
        ) : rooms.length > 0 ? (
          <div className="mt-12 w-full max-w-4xl mx-auto">
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">
              Active Rooms
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {rooms.map((room) => (
                <div
                  key={room.roomId}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col gap-3 hover:border-zinc-700 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <code className="text-sm font-mono text-zinc-300 truncate">
                      {room.roomId}
                    </code>
                    <span className="text-xs text-zinc-500">
                      {getRelativeTime(room.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-sm text-zinc-400">
                      <UsersIcon className="w-3.5 h-3.5" />
                      <span>
                        {room.userCount}{' '}
                        {room.userCount === 1 ? 'user' : 'users'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate(`/room/${room.roomId}`)}
                      className="px-3 py-1 text-sm font-medium text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-md hover:bg-orange-500/20 transition-colors"
                    >
                      Join
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
