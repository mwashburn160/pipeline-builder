// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from 'react';
import { MessageCircle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Message, SupportCaseSummary } from '@/types';
import { ThreadView } from './ThreadView';

/** Placeholder shown in the thread panel when no conversation is selected. */
function EmptyChat() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <EmptyState
        icon={MessageCircle}
        illustration="messages"
        title="Select a conversation"
        description="Choose from your conversations or start a new one"
      />
    </div>
  );
}

type MessagesThreadPanelProps = Omit<ComponentProps<typeof ThreadView>, 'rootMessage' | 'supportCase'> & {
  /** The open conversation, or null for the placeholder. */
  selectedMessage: Message | null;
  /** The org's support cases keyed by thread id (a case thread shows its panel). */
  casesByThread?: Record<string, SupportCaseSummary>;
};

/** The inbox's right panel: the open conversation's thread, or a placeholder. */
export function MessagesThreadPanel({ selectedMessage, casesByThread, ...threadProps }: MessagesThreadPanelProps) {
  return (
    <div className={`${selectedMessage ? 'flex' : 'hidden lg:flex'} flex-1 flex-col min-w-0`}>
      {selectedMessage ? (
        <ThreadView
          // Keyed by thread: the reply draft, its attachments and an open
          // inline edit belong to ONE thread — without a remount, text
          // typed in thread A would be sent into thread B.
          key={selectedMessage.id}
          supportCase={selectedMessage ? casesByThread?.[selectedMessage.id] : undefined}
          rootMessage={selectedMessage}
          {...threadProps}
        />
      ) : (
        <EmptyChat />
      )}
    </div>
  );
}
