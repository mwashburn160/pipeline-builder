import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Send, Megaphone, MessageCircle, AlertTriangle, AlertOctagon } from 'lucide-react';
import api from '@/lib/api';
import type { Message } from '@/types';

/** Props for the ThreadView component. */
interface ThreadViewProps {
  /** The root message that starts this conversation thread. */
  rootMessage: Message;
  /** The current user's organization ID, used to distinguish sent vs. received messages. */
  currentOrgId: string;
  /** Callback to navigate back to the message list (mobile). */
  onBack: () => void;
  /** Callback to mark a single message as read by ID. */
  onMarkAsRead: (id: string) => void;
  /** Callback to mark the entire thread as read when opened. */
  onThreadRead: (id: string) => void;
}

/** Formats a date string as a locale-specific date/time string. */
function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

/** Colored badge indicating message priority; renders nothing for "normal" priority. */
function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'normal') return null;
  const colors = priority === 'urgent'
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';
  const Icon = priority === 'urgent' ? AlertOctagon : AlertTriangle;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${colors}`}>
      <Icon className="w-3 h-3" />
      {priority}
    </span>
  );
}

/** Chat-style thread view displaying a conversation with reply input. */
export function ThreadView({ rootMessage, currentOrgId, onBack, onMarkAsRead, onThreadRead }: ThreadViewProps) {
  const [thread, setThread] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyContent, setReplyContent] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchThread = async () => {
    try {
      setLoading(true);
      const result = await api.getThread(rootMessage.id);
      setThread(result.data || []);
    } catch {
      setThread([rootMessage]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchThread();
    // Mark thread as read when viewing
    onThreadRead(rootMessage.id);
  }, [rootMessage.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread]);

  const handleSendReply = async () => {
    if (!replyContent.trim() || sending) return;

    setSending(true);
    try {
      const result = await api.replyToMessage(rootMessage.id, replyContent.trim());
      if (result.data) {
        setThread(prev => [...prev, result.data!]);
        setReplyContent('');
      }
    } catch {
      // Error handled silently
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendReply();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <button
          onClick={onBack}
          className="lg:hidden p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-gray-500" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {rootMessage.messageType === 'announcement' ? (
              <Megaphone className="w-4 h-4 text-amber-500 flex-shrink-0" />
            ) : (
              <MessageCircle className="w-4 h-4 text-blue-500 flex-shrink-0" />
            )}
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
              {rootMessage.messageType === 'announcement'
                ? 'Announcement'
                : rootMessage.orgId.toLowerCase() === currentOrgId.toLowerCase()
                  ? rootMessage.recipientOrgId
                  : rootMessage.orgId}
            </h2>
            <PriorityBadge priority={rootMessage.priority} />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {rootMessage.subject}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          thread.map((msg) => {
            const isMine = msg.orgId.toLowerCase() === currentOrgId.toLowerCase();
            return (
              <div
                key={msg.id}
                className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[75%] rounded-xl px-4 py-2.5 ${
                    isMine
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  }`}
                >
                  <div className={`text-xs mb-1 ${isMine ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}>
                    {msg.createdBy} ({msg.orgId})
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  <div className={`text-xs mt-1 ${isMine ? 'text-blue-200' : 'text-gray-400 dark:text-gray-500'}`}>
                    {formatDateTime(msg.createdAt)}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Reply input */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="flex items-end gap-2">
          <textarea
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your reply... (Enter to send, Shift+Enter for new line)"
            rows={2}
            className="flex-1 resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            onClick={handleSendReply}
            disabled={!replyContent.trim() || sending}
            className="p-2.5 rounded-xl bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
