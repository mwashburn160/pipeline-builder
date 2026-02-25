import { useState, useCallback } from 'react';
import { Plus, Megaphone, MessageCircle, Inbox } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useMessages } from '@/hooks/useMessages';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import { MessageList } from '@/components/message/MessageList';
import { ThreadView } from '@/components/message/ThreadView';
import { ComposeModal } from '@/components/message/ComposeModal';
import { MessageBadge } from '@/components/message/MessageBadge';
import type { Message } from '@/types';

const tabs = [
  { key: 'all' as const, label: 'All', icon: Inbox },
  { key: 'announcements' as const, label: 'Announcements', icon: Megaphone },
  { key: 'conversations' as const, label: 'Conversations', icon: MessageCircle },
] as const;

export default function MessagesPage() {
  const { user, isReady, isAuthenticated, isSysAdmin } = useAuthGuard();
  const {
    messages,
    loading,
    error,
    unreadCount,
    activeTab,
    setActiveTab,
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
  const selectedMessageId = selectedMessage?.id;

  return (
    <DashboardLayout
      title="Messages"
      titleExtra={unreadCount > 0 ? <MessageBadge count={unreadCount} /> : undefined}
      actions={
        <button
          onClick={() => setShowCompose(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          {isSysAdmin ? 'New Message' : 'Contact Support'}
        </button>
      }
    >
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden" style={{ minHeight: '600px' }}>
        {selectedMessage ? (
          <ThreadView
            rootMessage={selectedMessage}
            currentOrgId={currentOrgId}
            onBack={handleBack}
            onMarkAsRead={markAsRead}
            onThreadRead={markThreadAsRead}
          />
        ) : (
          <>
            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              {tabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === key
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              ))}
            </div>

            {/* Message list */}
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : error ? (
              <div className="text-center py-12">
                <p className="text-red-500 dark:text-red-400">{error}</p>
                <button
                  onClick={fetchMessages}
                  className="mt-3 text-sm text-blue-500 hover:text-blue-600"
                >
                  Try again
                </button>
              </div>
            ) : (
              <MessageList
                messages={messages}
                onSelect={handleSelectMessage}
                selectedId={selectedMessageId}
              />
            )}
          </>
        )}
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
