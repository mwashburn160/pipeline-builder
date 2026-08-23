import { Megaphone, MessageCircle, Trash2, User } from 'lucide-react';
import { formatRelativeTime } from '@/lib/relative-time';
import { SYSTEM_ORG_ID } from '@/lib/constants';
import { EmptyState } from '@/components/ui/EmptyState';
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
  /** Client-side org id → name backfill, used when the server didn't resolve
   *  `orgName`/`recipientOrgName` onto the row (falls back to the id). */
  resolveOrgName?: (id?: string | null) => string | undefined;
  /** Callback to delete a message by ID. */
  onDelete?: (id: string) => void;
  /** True when more inbox pages exist beyond what's rendered. */
  hasMore?: boolean;
  /** True while the next page is loading (disables the button + shows a spinner). */
  loadingMore?: boolean;
  /** Load the next inbox page (server-side pagination). */
  onLoadMore?: () => void;
  /** Empty-state title override (e.g. "No results" when a search is active). */
  emptyTitle?: string;
  /** Empty-state description override. */
  emptyDescription?: string;
}

/**
 * Returns the display name for a message row: "Announcement", or the OTHER
 * party's org name (server-enriched `*OrgName`, else the client-side
 * `resolveOrgName` backfill, else the raw id). When the current org is the
 * sender, the other party is the recipient, and vice-versa.
 *
 * The support desk (system org) is special-cased: its configured label
 * (`resolveOrgName` → "support and help") wins over the raw "system" org name
 * the server enriches onto the row.
 */
function getDisplayName(
  msg: Message,
  currentOrgId: string,
  resolveOrgName?: (id?: string | null) => string | undefined,
): string {
  if (msg.messageType === 'announcement') return 'Announcement';
  const mine = msg.orgId.toLowerCase() === currentOrgId.toLowerCase();
  const otherId = mine ? msg.recipientOrgId : msg.orgId;
  const otherName = mine ? msg.recipientOrgName : msg.orgName;
  if (otherId?.toLowerCase() === SYSTEM_ORG_ID) {
    return resolveOrgName?.(otherId) || otherName || otherId;
  }
  return otherName || resolveOrgName?.(otherId) || otherId;
}

/**
 * Per-participant unread check. Returns true when the *current* org has not
 * marked this message read — independent of whether other participants have.
 */
function isUnreadFor(msg: Message, currentOrgId: string): boolean {
  // Guard `readBy` — a message pushed via SSE/poll can arrive without it, and
  // this runs for every row on render; an unguarded deref would crash the whole
  // list (matches the `?.` used in useMessages / ThreadView).
  return !msg.readBy?.[currentOrgId.toLowerCase()];
}

/** Extracts the first two characters of a name for avatar display. */
function getAvatarLetters(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/** Scrollable inbox list displaying message previews with unread indicators. */
export function MessageList({ messages, onSelect, selectedId, currentOrgId, resolveOrgName, onDelete, hasMore, loadingMore, onLoadMore, emptyTitle, emptyDescription }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={MessageCircle}
          illustration="messages"
          title={emptyTitle ?? 'No messages'}
          description={emptyDescription ?? 'Start a conversation or wait for a message'}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {messages.map((msg) => {
        const displayName = getDisplayName(msg, currentOrgId, resolveOrgName);
        const isAnnouncement = msg.messageType === 'announcement';
        const isSelected = selectedId === msg.id;

        return (
          <div
            key={msg.id}
            role="button"
            tabIndex={0}
            aria-current={isSelected ? 'true' : undefined}
            className={`group relative w-full text-left px-3 py-3 flex items-center gap-3 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset ${
              isSelected
                ? 'bg-blue-50 dark:bg-blue-900/20'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            onClick={() => onSelect(msg)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(msg); }
            }}
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
                    isUnreadFor(msg, currentOrgId)
                      ? 'font-semibold text-gray-900 dark:text-gray-100'
                      : 'font-medium text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {displayName}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 ml-2">
                  {formatRelativeTime(msg.createdAt)}
                </span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {msg.content.slice(0, 60)}
                </p>
                <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                  {msg.recipientUserId && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      title="Direct message — targeted at a specific user"
                    >
                      <User className="w-2.5 h-2.5" />
                      Direct
                    </span>
                  )}
                  {msg.channel && (
                    <span
                      className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                      title={`Channel: ${msg.channel}`}
                    >
                      {msg.channel}
                    </span>
                  )}
                  {isUnreadFor(msg, currentOrgId) && (
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                  )}
                </div>
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

      {/* Server-side pagination — appends the next page in place. */}
      {hasMore && onLoadMore && (
        <div className="px-3 py-3">
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="w-full text-center text-xs font-medium py-2 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
