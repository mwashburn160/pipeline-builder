import { Megaphone, MessageCircle, Trash2 } from 'lucide-react';
import type { Message } from '@/types';

/** Props for the MessageList component. */
interface MessageListProps {
  /** Array of messages to display in the inbox. */
  messages: Message[];
  /** Callback when a message row is clicked. */
  onSelect: (message: Message) => void;
  /** ID of the currently selected message, used for highlight styling. */
  selectedId?: string;
  /** The current user's organization ID, used to determine sender display names. */
  currentOrgId: string;
  /** Callback to delete a message by ID. */
  onDelete?: (id: string) => void;
}

/** Formats a date string as a relative time label (e.g. "5m ago", "2d ago"). */
function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/** Returns the display name for a message row: "Announcement" or the other party's org ID. */
function getDisplayName(msg: Message, currentOrgId: string): string {
  if (msg.messageType === 'announcement') return 'Announcement';
  if (msg.orgId.toLowerCase() === currentOrgId.toLowerCase()) return msg.recipientOrgId;
  return msg.orgId;
}

/** Extracts the first two characters of a name for avatar display. */
function getAvatarLetters(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/** Scrollable inbox list displaying message previews with unread indicators. */
export function MessageList({ messages, onSelect, selectedId, currentOrgId, onDelete }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 py-12">
        <MessageCircle className="w-12 h-12 mb-3 opacity-40" />
        <p className="text-base font-medium">No messages</p>
        <p className="text-sm mt-1">Start a conversation or wait for a message</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {messages.map((msg) => {
        const displayName = getDisplayName(msg, currentOrgId);
        const isAnnouncement = msg.messageType === 'announcement';
        const isSelected = selectedId === msg.id;

        return (
          <div
            key={msg.id}
            className={`group relative w-full text-left px-3 py-3 flex items-center gap-3 transition-colors cursor-pointer ${
              isSelected
                ? 'bg-blue-50 dark:bg-blue-900/20'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            onClick={() => onSelect(msg)}
          >
            {/* Avatar */}
            <div
              className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-semibold relative ${
                isAnnouncement
                  ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                  : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
              }`}
            >
              {isAnnouncement ? (
                <Megaphone className="w-5 h-5" />
              ) : (
                getAvatarLetters(displayName)
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span
                  className={`text-sm truncate ${
                    !msg.isRead
                      ? 'font-semibold text-gray-900 dark:text-gray-100'
                      : 'font-medium text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {displayName}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 ml-2">
                  {formatTime(msg.createdAt)}
                </span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {msg.content.slice(0, 60)}
                </p>
                {!msg.isRead && (
                  <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 ml-2" />
                )}
              </div>
            </div>

            {/* Delete button (visible on hover) */}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(msg.id); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-all"
                title="Delete message"
                aria-label="Delete message"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
