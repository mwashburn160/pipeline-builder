import { Megaphone, MessageCircle, Clock, AlertTriangle, AlertOctagon } from 'lucide-react';
import type { Message } from '@/types';

interface MessageListProps {
  messages: Message[];
  onSelect: (message: Message) => void;
  selectedId?: string;
}

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

function PriorityIcon({ priority }: { priority: string }) {
  if (priority === 'urgent') return <AlertOctagon className="w-4 h-4 text-red-500" />;
  if (priority === 'high') return <AlertTriangle className="w-4 h-4 text-orange-500" />;
  return null;
}

export function MessageList({ messages, onSelect, selectedId }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <MessageCircle className="w-12 h-12 mx-auto mb-3 opacity-40" />
        <p className="text-lg font-medium">No messages</p>
        <p className="text-sm mt-1">Messages from the system will appear here</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-200 dark:divide-gray-700">
      {messages.map((msg) => (
        <button
          key={msg.id}
          onClick={() => onSelect(msg)}
          className={`w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
            selectedId === msg.id ? 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-blue-500' : ''
          } ${!msg.isRead ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}
        >
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              {msg.messageType === 'announcement' ? (
                <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <Megaphone className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <MessageCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {!msg.isRead && (
                  <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                )}
                <span className={`text-sm truncate ${!msg.isRead ? 'font-semibold text-gray-900 dark:text-gray-100' : 'font-medium text-gray-700 dark:text-gray-300'}`}>
                  {msg.subject}
                </span>
                <PriorityIcon priority={msg.priority} />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                {msg.content.slice(0, 100)}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  From: {msg.orgId}
                </span>
                <span className="text-xs text-gray-300 dark:text-gray-600">|</span>
                <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatTime(msg.createdAt)}
                </span>
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
