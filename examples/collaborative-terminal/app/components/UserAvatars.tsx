import type { User } from '../types';

interface UserAvatarsProps {
  users: User[];
  currentUserId: string | null;
  typingUsers: Set<string>;
}

export function UserAvatars({
  users,
  currentUserId,
  typingUsers
}: UserAvatarsProps) {
  return (
    <div className="flex items-center -space-x-2">
      {users.map((user) => (
        <div
          key={user.id}
          className="relative group"
          title={user.id === currentUserId ? `${user.name} (you)` : user.name}
        >
          <div
            className="w-8 h-8 rounded-full border-2 border-zinc-900 flex items-center justify-center text-xs font-medium text-white"
            style={{ backgroundColor: user.color }}
          >
            {user.name.charAt(0).toUpperCase()}
          </div>
          {typingUsers.has(user.id) && (
            <span className="absolute -bottom-1 -right-1 flex h-3 w-3">
              <span
                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                style={{ backgroundColor: user.color }}
              />
              <span
                className="relative inline-flex rounded-full h-3 w-3"
                style={{ backgroundColor: user.color }}
              />
            </span>
          )}
          <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-zinc-800 text-xs text-zinc-200 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            {user.name}
            {user.id === currentUserId && ' (you)'}
          </div>
        </div>
      ))}
    </div>
  );
}
