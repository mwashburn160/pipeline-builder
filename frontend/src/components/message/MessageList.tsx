import { Megaphone, MessageCircle, Trash2, User } from 'lucide-react';
import { formatRelativeTime } from '@/lib/relative-time';
import { SYSTEM_ORG_ID } from '@/lib/constants';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Message, SupportCaseSummary } from '@/types';

/** Props for the MessageList component. */
/**
 * Case status, in words a customer understands.
 *
 * `awaiting_support` and `awaiting_customer` are the two that matter and the
 * two a raw value gets wrong: the stored name says who is being waited ON,
 * which reads backwards to a tenant looking at their own case. "Waiting on us"
 * / "Waiting on you" is the same fact from the reader's side.
 *
 * EXPORTED so its test can call the real thing. The sibling `isUnreadFor` in
 * this file is not, and its test mirrors a copy instead — whose own comment
 * says it "should fail" if the semantics change, which a copy cannot do.
 */
/**
 * The first-response target a case was opened under, in words.
 *
 * Attached to the case rather than shown only on a pricing page, because the
 * promise belongs on the thing it is about: a customer looking at a case should
 * be able to see what was committed for THAT case, not infer it from what their
 * plan says today.
 *
 * Derived from the case's FROZEN `level`, which is why it stays truthful after a
 * downgrade — the case keeps the target it was opened under.
 *
 * `null` for an unrecognised level rather than a guess: a level this build does
 * not know about must not be described with another level's commitment, and the
 * caller omits the phrase entirely.
 */
export function responseTargetLabel(level: string): string | null {
  switch (level) {
    // Business days, not business hours. "48 business hours" reads to a customer
    // as two days and means six, so the old wording flattered the commitment by
    // about three times — and a promise a customer feels misled by is worse than
    // a slower one stated straight.
    case 'support_standard': return '2 business days';
    case 'support_priority': return 'next business day';
    // Premium is the only level with a clock that does not stop for nights or
    // weekends, so its number is stated on that clock: better than priority
    // every day of the week, not just at weekends.
    case 'support_premium': return '8 hours, any day';
    default: return null;
  }
}

export function caseStatusLabel(status: string): string {
  switch (status) {
    case 'awaiting_support': return 'waiting on us';
    case 'awaiting_customer': return 'waiting on you';
    case 'resolved': return 'resolved';
    case 'closed': return 'closed';
    default: return 'open';
  }
}

/**
 * The chip's hover text: case number, status, and the response target it was
 * opened under.
 *
 * Separate from the JSX so it can be tested directly — the target phrase is
 * omitted rather than faked when the level is unrecognised, and that branch is
 * invisible in a rendered string.
 */
export function caseTitle(c: SupportCaseSummary): string {
  const target = responseTargetLabel(c.level);
  const head = `Case #${c.displayNumber} — ${caseStatusLabel(c.status)}`;
  return target ? `${head}. First-response target: ${target}` : head;
}

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
  /**
   * The org's support cases, keyed by `threadId` — which IS the case identity
   * (the root message's id), so a row looks itself up with no extra request.
   *
   * Absent or empty is normal rather than an error state: support correspondence
   * sent before the support add-on existed has no case record, deliberately
   * (backfilling one would have put months-old "open" cases into the staff queue
   * and poisoned the first-response metric). Those rows simply show no case chip.
   */
  casesByThread?: Record<string, SupportCaseSummary>;
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
export function MessageList({ messages, onSelect, selectedId, currentOrgId, resolveOrgName, onDelete, hasMore, loadingMore, onLoadMore, casesByThread, emptyTitle, emptyDescription }: MessageListProps) {
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
            className={`group relative w-full text-left px-3 py-3 flex items-center gap-3 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pb-ring)] focus-visible:ring-inset ${
              isSelected
                ? 'bg-info-bg'
                : 'hover:bg-surface-muted'
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
                  ? 'bg-warning-bg text-warning'
                  : 'bg-info-bg text-info-strong'
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
                      ? 'font-semibold text-fg'
                      : 'font-medium text-fg-muted'
                  }`}
                >
                  {displayName}
                </span>
                <span className="text-xs text-fg-subtle flex-shrink-0 ml-2">
                  {formatRelativeTime(msg.createdAt)}
                </span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <p className="text-xs text-fg-muted truncate">
                  {msg.content.slice(0, 60)}
                </p>
                <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                  {msg.recipientUserId && (
                    <span
                      className="inline-flex items-center gap-0.5 text-2xs uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-info-bg text-info-strong"
                      title="Direct message — targeted at a specific user"
                    >
                      <User className="w-2.5 h-2.5" />
                      Direct
                    </span>
                  )}
                  {msg.channel && (
                    <span
                      className="text-2xs uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-success-bg text-success"
                      title={`Channel: ${msg.channel}`}
                    >
                      {msg.channel}
                    </span>
                  )}
                  {/* The case number and status, for a support thread that has a
                      case. This is the identifier a customer quotes back, so it
                      belongs on the row rather than only inside the thread.
                      Status is shown as text, not colour alone. */}
                  {casesByThread?.[msg.id] && (
                    <span
                      className="text-2xs uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-surface-muted text-fg-muted"
                      title={caseTitle(casesByThread[msg.id]!)}
                    >
                      {`#${casesByThread[msg.id]!.displayNumber} ${caseStatusLabel(casesByThread[msg.id]!.status)}`}
                    </span>
                  )}
                  {/* The dot is the visual cue; the sr-only text carries it for
                      screen readers, which can't perceive a colour. */}
                  {isUnreadFor(msg, currentOrgId) && (
                    <span className="inline-flex items-center">
                      <span className="w-2 h-2 rounded-full bg-blue-500" aria-hidden="true" />
                      <span className="sr-only">Unread</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Delete button (visible on hover) */}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(msg.id); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-fg-subtle hover:text-danger hover:bg-danger-bg opacity-0 group-hover:opacity-100 transition-all"
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
            className="w-full text-center text-xs font-medium py-2 rounded-lg text-brand hover:bg-info-bg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
