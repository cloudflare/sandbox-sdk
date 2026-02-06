import type { SandboxAddon } from '@cloudflare/sandbox/xterm';
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { UserAvatars } from '../components/UserAvatars';
import { useActiveRooms } from '../hooks/useActiveRooms';
import { usePresence } from '../hooks/usePresence';
import { generateName } from '../utils/names';
import type { Route } from './+types/room';

const Terminal = lazy(() =>
  import('../components/Terminal.client').then((m) => ({ default: m.Terminal }))
);
export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Room ${params.roomId}` }];
}
export default function RoomPage({ params }: Route.ComponentProps) {
  const { roomId } = params;
  const navigate = useNavigate();
  const userName = useMemo(() => generateName(), []);
  const [copied, setCopied] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const addonRef = useRef<SandboxAddon | null>(null);
  const { rooms } = useActiveRooms();
  const otherRooms = rooms.filter((r) => r.roomId !== roomId);
  const switchRoom = useCallback(
    (newRoomId: string) => {
      addonRef.current?.connect({
        sandboxId: 'shared-terminal',
        sessionId: `room-${newRoomId}`
      });
      navigate(`/room/${newRoomId}`, { replace: true });
    },
    [navigate]
  );
  const handleRoomDeleted = useCallback(() => {
    const next = otherRooms[0];
    if (next) {
      switchRoom(next.roomId);
    } else {
      navigate('/', { replace: true });
    }
  }, [otherRooms, switchRoom, navigate]);
  const { state, currentUser, users, room, typingUsers, sendTyping } =
    usePresence({ roomId, userName, onRoomDeleted: handleRoomDeleted });
  const deleteRoom = async (targetRoomId: string) => {
    await fetch(`/api/room/${targetRoomId}`, { method: 'DELETE' });
  };
  const createRoom = async () => {
    const response = await fetch('/api/room', { method: 'POST' });
    const data = (await response.json()) as { roomId: string };
    switchRoom(data.roomId);
  };
  const copyLink = async () => {
    const url = `${window.location.origin}/room/${roomId}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="h-screen flex flex-col bg-zinc-950">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className="flex items-center gap-2 text-zinc-100 hover:text-orange-500 transition-colors"
          >
            <TerminalIcon className="w-5 h-5 text-orange-500" />
            <span className="font-semibold">Sandbox</span>
          </Link>
          <div className="h-4 w-px bg-zinc-800" />
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">Room</span>
            <code className="px-2 py-0.5 bg-zinc-900 rounded text-sm text-zinc-300 font-mono">
              {roomId}
            </code>
            <ConnectionIndicator state={state} />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <UserAvatars
            users={users}
            currentUserId={currentUser?.id ?? null}
            typingUsers={typingUsers}
          />
          <button
            type="button"
            onClick={copyLink}
            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-200 rounded-lg transition-colors"
          >
            {copied ? (
              <>
                <CheckIcon className="w-4 h-4 text-green-500" />
                Copied!
              </>
            ) : (
              <>
                <ShareIcon className="w-4 h-4" />
                Share
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-200 rounded-lg transition-colors"
            title={sidebarOpen ? 'Hide rooms' : 'Show rooms'}
          >
            <SidebarIcon className="w-4 h-4" />
          </button>
        </div>
      </header>
      <main className="flex-1 flex min-h-0">
        <div className="flex-1 p-4 min-h-0">
          <div className="h-full rounded-lg overflow-hidden border border-zinc-800">
            <div className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <div className="w-3 h-3 rounded-full bg-green-500" />
              </div>
              <span className="text-xs text-zinc-500 ml-2">bash</span>
            </div>
            <div className="h-[calc(100%-40px)] bg-zinc-950">
              {room ? (
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center h-full text-zinc-500">
                      Loading terminal...
                    </div>
                  }
                >
                  <Terminal
                    sandboxId="shared-terminal"
                    sessionId={room.sessionId}
                    onTyping={sendTyping}
                    onAddonReady={(addon) => {
                      addonRef.current = addon;
                    }}
                  />
                </Suspense>
              ) : (
                <div className="flex items-center justify-center h-full text-zinc-500">
                  Connecting to room...
                </div>
              )}
            </div>
          </div>
        </div>
        {sidebarOpen && (
          <aside className="w-64 border-l border-zinc-800 p-4 flex flex-col gap-4 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Rooms</h3>
              <button
                type="button"
                onClick={createRoom}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded hover:bg-orange-500/20 transition-colors"
              >
                <PlusIcon className="w-3 h-3" />
                New
              </button>
            </div>
            <div className="bg-zinc-900 border border-orange-500/30 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 bg-orange-500 rounded-full" />
                  <span className="text-xs text-orange-400 font-medium">
                    Current
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => deleteRoom(roomId)}
                  className="p-0.5 text-zinc-500 hover:text-red-400 transition-colors"
                  title="Delete room"
                >
                  <TrashIcon className="w-3 h-3" />
                </button>
              </div>
              <code className="text-sm font-mono text-zinc-200 block truncate">
                {roomId}
              </code>
              <div className="flex items-center gap-1.5 mt-2 text-xs text-zinc-400">
                <UsersIcon className="w-3 h-3" />
                <span>
                  {users.length} {users.length === 1 ? 'user' : 'users'}
                </span>
              </div>
            </div>
            {otherRooms.length > 0 ? (
              <div className="flex flex-col gap-2">
                {otherRooms.map((r) => (
                  <button
                    key={r.roomId}
                    type="button"
                    onClick={() => switchRoom(r.roomId)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 hover:border-zinc-600 transition-colors text-left group"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <code className="text-sm font-mono text-zinc-300 truncate">
                        {r.roomId}
                      </code>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteRoom(r.roomId);
                        }}
                        className="p-0.5 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                        title="Delete room"
                      >
                        <TrashIcon className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <UsersIcon className="w-3 h-3" />
                      <span>
                        {r.userCount} {r.userCount === 1 ? 'user' : 'users'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-500 text-center py-4">
                No other active rooms
              </p>
            )}
          </aside>
        )}
      </main>
    </div>
  );
}
function ConnectionIndicator({ state }: { state: string }) {
  const colors = {
    connected: 'bg-green-500',
    connecting: 'bg-yellow-500 animate-pulse',
    disconnected: 'bg-red-500'
  };
  const labels = {
    connected: 'Connected',
    connecting: 'Connecting',
    disconnected: 'Disconnected'
  };
  return (
    <div
      className="flex items-center gap-1.5"
      title={labels[state as keyof typeof labels]}
    >
      <span
        className={`w-2 h-2 rounded-full ${colors[state as keyof typeof colors]}`}
      />
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
function SidebarIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
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
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
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
function ShareIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
