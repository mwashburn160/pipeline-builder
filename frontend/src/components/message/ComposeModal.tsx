import { useState } from 'react';
import { X, Send } from 'lucide-react';
import type { MessageType, MessagePriority } from '@/types';
import { useAsyncCallback } from '@/hooks/useAsync';
// Non-sysadmin sends always go to the system support inbox. The display
// alias `support@pipeline-builder` is shown verbatim in the "To" field
// for user familiarity; on the wire it's translated to recipientOrgId
// = "system" with channel = "support" so system-org readers can filter
// by channel.
const SUPPORT_ALIAS = 'support@pipeline-builder';
const SUPPORT_RECIPIENT = 'system';
const SUPPORT_CHANNEL = 'support';

/** Props for the ComposeModal component. */
interface ComposeModalProps {
  /** Whether the modal is visible. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback to send the composed message; resolves on success. */
  onSend: (data: {
    recipientOrgId: string;
    messageType: MessageType;
    subject: string;
    content: string;
    priority?: MessagePriority;
    channel?: string;
  }) => Promise<unknown>;
  /** Whether the current user is a sysadmin (enables free-form recipient
   *  entry and broadcast announcements). Non-sysadmins see the support-alias
   *  pre-fill with their own org's other teams as datalist suggestions. */
  isSuperAdmin: boolean;
  /** Other orgs/teams the user can message (e.g. sub-orgs they belong to).
   *  Rendered as a `<datalist>` so the To input auto-completes by name. */
  recipientSuggestions?: ReadonlyArray<{ value: string; label: string }>;
}

/** Derives a subject line from message content, truncating to 60 characters. */
function autoSubject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 60) + '...';
}

/** Modal for composing and sending new messages or announcements to organizations. */
export function ComposeModal({ isOpen, onClose, onSend, isSuperAdmin, recipientSuggestions = [] }: ComposeModalProps) {
  const [recipientOrgId, setRecipientOrgId] = useState('');
  // Non-sysadmin To-field state. Pre-filled with the support alias;
  // users can override it with a team/member name within their org.
  const [supportRecipient, setSupportRecipient] = useState(SUPPORT_ALIAS);
  const [content, setContent] = useState('');
  const [validationError, setValidationError] = useState('');
  const [isAnnouncement, setIsAnnouncement] = useState(false);

  const { execute: sendAsync, loading: sending, error: sendError } = useAsyncCallback(
    (data: Parameters<typeof onSend>[0]) => onSend(data),
  );

  const error = validationError || sendError || '';

  if (!isOpen) return null;

  const handleSend = async () => {
    setValidationError('');

    if (!content.trim()) {
      setValidationError('Message content is required');
      return;
    }

    // Compute the recipient. Non-sysadmin: the To field is editable —
    // if the user kept the support alias, route to the system support
    // inbox; otherwise treat the typed value as a team/member name
    // within their org and pass it straight through as recipientOrgId
    // (server-side resolves it / authorizes).
    const isSupportSend = !isSuperAdmin && supportRecipient.trim().toLowerCase() === SUPPORT_ALIAS;
    const recipient = isAnnouncement
      ? '*'
      : (isSuperAdmin
          ? recipientOrgId.trim().toLowerCase()
          : (isSupportSend ? SUPPORT_RECIPIENT : supportRecipient.trim().toLowerCase()));
    if (!isAnnouncement && !recipient) {
      setValidationError(isSuperAdmin
        ? 'Recipient organization is required'
        : 'Recipient is required');
      return;
    }

    // Only support-channel sends carry the channel field. Direct-to-
    // teammate sends are org-to-org so they don't need a channel tag.
    const channel = isSupportSend ? SUPPORT_CHANNEL : undefined;

    const result = await sendAsync({
      recipientOrgId: recipient,
      messageType: isAnnouncement ? 'announcement' : 'conversation',
      subject: autoSubject(content),
      content: content.trim(),
      priority: 'normal',
      ...(channel && { channel }),
    });

    if (result !== null) {
      setContent('');
      setRecipientOrgId('');
      setSupportRecipient(SUPPORT_ALIAS);
      setIsAnnouncement(false);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={isAnnouncement ? 'New Announcement' : 'New Message'}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {isAnnouncement ? 'New Announcement' : 'New Message'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* System org: toggle announcement vs conversation */}
          {isSuperAdmin && (
            <div className="flex gap-2">
              <button
                onClick={() => setIsAnnouncement(false)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  !isAnnouncement
                    ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                Message
              </button>
              <button
                onClick={() => setIsAnnouncement(true)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  isAnnouncement
                    ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                Announcement
              </button>
            </div>
          )}

          {/* Recipient (system org conversations only) */}
          {isSuperAdmin && !isAnnouncement && (
            <input
              type="text"
              value={recipientOrgId}
              onChange={(e) => setRecipientOrgId(e.target.value)}
              placeholder="To: Organization ID"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}

          {/* Non-system org: pre-filled support recipient (editable; type
              to override with one of the user's other teams/sub-orgs —
              the datalist auto-completes from `recipientSuggestions`). */}
          {!isSuperAdmin && (
            <div className="flex items-center gap-2 text-sm bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <span className="text-gray-500 dark:text-gray-400">To:</span>
              <input
                type="text"
                value={supportRecipient}
                onChange={(e) => setSupportRecipient(e.target.value)}
                list="compose-recipient-options"
                className="flex-1 bg-transparent text-gray-700 dark:text-gray-300 font-medium border-none focus:outline-none focus:ring-0"
                aria-label="Recipient (defaults to support; type a teammate or sub-org name to override)"
              />
              <datalist id="compose-recipient-options">
                <option value={SUPPORT_ALIAS}>Pipeline Builder Support</option>
                {recipientSuggestions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </datalist>
            </div>
          )}

          {/* Content */}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
            rows={4}
            className="w-full resize-none rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !content.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            <Send className="w-4 h-4" />
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
