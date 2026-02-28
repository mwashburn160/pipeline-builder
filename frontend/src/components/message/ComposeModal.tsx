import { useState } from 'react';
import { X, Send } from 'lucide-react';
import type { MessageType, MessagePriority } from '@/types';
import { useAsyncCallback } from '@/hooks/useAsync';

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
  }) => Promise<unknown>;
  /** Whether the current org is the system org (enables recipient selection and announcements). */
  isSystemOrg: boolean;
}

/** Derives a subject line from message content, truncating to 60 characters. */
function autoSubject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 60) + '...';
}

/** Modal for composing and sending new messages or announcements to organizations. */
export function ComposeModal({ isOpen, onClose, onSend, isSystemOrg }: ComposeModalProps) {
  const [recipientOrgId, setRecipientOrgId] = useState('');
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

    const recipient = isAnnouncement ? '*' : (isSystemOrg ? recipientOrgId.trim().toLowerCase() : 'system');
    if (isSystemOrg && !isAnnouncement && !recipient) {
      setValidationError('Recipient organization is required');
      return;
    }

    const result = await sendAsync({
      recipientOrgId: recipient,
      messageType: isAnnouncement ? 'announcement' : 'conversation',
      subject: autoSubject(content),
      content: content.trim(),
      priority: 'normal',
    });

    if (result !== null) {
      setContent('');
      setRecipientOrgId('');
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {isAnnouncement ? 'New Announcement' : 'New Message'}
          </h2>
          <button
            onClick={onClose}
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
          {isSystemOrg && (
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
          {isSystemOrg && !isAnnouncement && (
            <input
              type="text"
              value={recipientOrgId}
              onChange={(e) => setRecipientOrgId(e.target.value)}
              placeholder="To: Organization ID"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}

          {/* Non-system org info */}
          {!isSystemOrg && (
            <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              To: <span className="font-medium text-gray-700 dark:text-gray-300">System Admin</span>
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
