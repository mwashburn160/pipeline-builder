import { useState, useCallback } from 'react';
import { Plus, MessageCircle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useMessages } from '@/hooks/useMessages';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import { MessageList } from '@/components/message/MessageList';
import { ThreadView } from '@/components/message/ThreadView';
import { ComposeModal } from '@/components/message/ComposeModal';
import { MessageBadge } from '@/components/message/MessageBadge';
import type { Message } from '@/types';

/** Placeholder shown in the thread panel when no conversation is selected. */
function EmptyChat() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500">
      <MessageCircle className="w-16 h-16 mb-4 opacity-30" />
      <p className="text-lg font-medium">Select a conversation</p>
      <p className="text-sm mt-1">Choose from your conversations or start a new one</p>
    </div>
  );
}

/** Message inbox page. Displays conversations in a split-panel layout with compose, thread view, and unread tracking. */
export default function MessagesPage() {
  const { user, isReady, isSysAdmin } = useAuthGuard();
  const {
    messages,
    loading,
    error,
    unreadCount,
    sendMessage,
    markAsRead,
    markThreadAsRead,
    fetchMessages,
  } = useMessages();

  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showCompose, setShowCompose] = useState(false);

  const handleSelectMessage = useCallback((msg: Message) => {
    setSelectedMessage(msg);
    if (!msg.isRead) {
      markAsRead(msg.id);
    }
  }, [markAsRead]);

  const handleBack = useCallback(() => {
    setSelectedMessage(null);
    fetchMessages();
  }, [fetchMessages]);

  const handleSend = useCallback(async (data: Parameters<typeof sendMessage>[0]) => {
    await sendMessage(data);
  }, [sendMessage]);

  if (!isReady || !user) return <LoadingPage />;

  const currentOrgId = user.organizationId?.toLowerCase() || '';

  return (
    <DashboardLayout
      title="Messages"
      subtitle="Inbox and conversations with your team"
      titleExtra={unreadCount > 0 ? <MessageBadge count={unreadCount} /> : undefined}
    >
      <div className="page-section">
        <div className="card flex overflow-hidden" style={{ height: 'calc(100vh - 140px)', minHeight: '500px' }}>

          {/* Left panel: conversation list */}
          <div className={`${selectedMessage ? 'hidden lg:flex' : 'flex'} w-full lg:w-80 flex-shrink-0 lg:border-r border-gray-200 dark:border-gray-700 flex-col`}>
            {/* List header */}
            <div className="flex items-center justify-between px-3 py-3 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Conversations</h2>
              <button
                onClick={() => setShowCompose(true)}
                className="p-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                title={isSysAdmin ? 'New Message' : 'Contact Support'}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {/* Message list */}
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : error ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
                <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
              <button
                onClick={fetchMessages}
                className="action-link mt-2"
              >
                Try again
              </button>
              </div>
            ) : (
              <MessageList
                messages={messages}
                onSelect={handleSelectMessage}
                selectedId={selectedMessage?.id}
                currentOrgId={currentOrgId}
              />
            )}
          </div>

          {/* Right panel: chat or empty state */}
          <div className={`${selectedMessage ? 'flex' : 'hidden lg:flex'} flex-1 flex-col min-w-0`}>
            {selectedMessage ? (
              <ThreadView
                rootMessage={selectedMessage}
                currentOrgId={currentOrgId}
                onBack={handleBack}
                onMarkAsRead={markAsRead}
                onThreadRead={markThreadAsRead}
              />
            ) : (
              <EmptyChat />
            )}
          </div>
        </div>
      </div>

      {/* Compose modal */}
      <ComposeModal
        isOpen={showCompose}
        onClose={() => setShowCompose(false)}
        onSend={handleSend}
        isSystemOrg={isSysAdmin}
      />
    </DashboardLayout>
  );
}
