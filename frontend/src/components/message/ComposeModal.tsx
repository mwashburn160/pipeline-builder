import { useState } from 'react';
import { X, Send } from 'lucide-react';
import type { MessageType, MessagePriority } from '@/types';

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (data: {
    recipientOrgId: string;
    messageType: MessageType;
    subject: string;
    content: string;
    priority?: MessagePriority;
  }) => Promise<unknown>;
  isSystemOrg: boolean;
}

export function ComposeModal({ isOpen, onClose, onSend, isSystemOrg }: ComposeModalProps) {
  const [messageType, setMessageType] = useState<MessageType>('conversation');
  const [recipientOrgId, setRecipientOrgId] = useState(isSystemOrg ? '' : 'system');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState<MessagePriority>('normal');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSend = async () => {
    setError('');

    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    if (!content.trim()) {
      setError('Message content is required');
      return;
    }

    const recipient = messageType === 'announcement' ? '*' : recipientOrgId.trim().toLowerCase();
    if (!recipient) {
      setError('Recipient organization is required');
      return;
    }

    setSending(true);
    try {
      await onSend({
        recipientOrgId: recipient,
        messageType,
        subject: subject.trim(),
        content: content.trim(),
        priority,
      });
      // Reset form
      setSubject('');
      setContent('');
      setPriority('normal');
      setRecipientOrgId(isSystemOrg ? '' : 'system');
      setMessageType('conversation');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">New Message</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Message type (only for system org) */}
          {isSystemOrg && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
              <div className="flex gap-2">
                <button
                  onClick={() => { setMessageType('conversation'); setRecipientOrgId(''); }}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    messageType === 'conversation'
                      ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                      : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  Conversation
                </button>
                <button
                  onClick={() => { setMessageType('announcement'); setRecipientOrgId('*'); }}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    messageType === 'announcement'
                      ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                      : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  Announcement
                </button>
              </div>
            </div>
          )}

          {/* Recipient (only for system org conversations) */}
          {isSystemOrg && messageType === 'conversation' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">To (Org ID)</label>
              <input
                type="text"
                value={recipientOrgId}
                onChange={(e) => setRecipientOrgId(e.target.value)}
                placeholder="Enter organization ID"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {/* Non-system org info */}
          {!isSystemOrg && (
            <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              Sending to: <span className="font-medium text-gray-700 dark:text-gray-300">System Admin</span>
            </div>
          )}

          {/* Subject */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Message subject"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as MessagePriority)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          {/* Content */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Message</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Type your message..."
              rows={5}
              className="w-full resize-none rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending}
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
