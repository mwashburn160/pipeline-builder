// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { LifeBuoy, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useFeatures } from '@/hooks/useFeatures';
import type { MessagePriority } from '@/types';
import api from '@/lib/api';
import { aliasLocalPart } from '@/lib/support-label';

const ComposeModal = dynamic(() => import('@/components/message/ComposeModal').then((m) => m.ComposeModal), { ssr: false });

/** Props for {@link ContactSupportCard}. */
interface ContactSupportCardProps {
  /** `messages:read` — the permission `POST /messages/support` is gated on.
   *  Without it the send would 403, so the card points at the docs instead. */
  canMessage: boolean;
}

/**
 * The Help page's outbound path.
 *
 * Without it Help is a terminal surface: a search box, a topic index and no way
 * to reach a human. The contact form is the `!canWrite` branch of
 * {@link ComposeModal}, otherwise reachable only from the Messages nav item,
 * which a reader looking for help has no reason to open. This mounts the
 * same compose flow directly, in support mode (`canWrite={false}`): the
 * recipient is not a choice, and the send goes to `POST /messages/support`,
 * whose recipient the server forces and which needs only `messages:read`.
 *
 * Sending from here deliberately does NOT route through `useMessages` — that
 * hook re-reads the whole inbox after a send, which is pointless work on a page
 * that shows no inbox. The reply lands in Messages either way. It also confirms
 * the send INLINE rather than through `useToast`, so this card (which renders on
 * every Help page load) carries no dependency on a ToastProvider being above it.
 */
export function ContactSupportCard({ canMessage }: ContactSupportCardProps) {
  const { supportAlias, supportAliases } = useFeatures();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async (data: { subject: string; content: string; priority?: MessagePriority; attachmentIds?: string[] }): Promise<boolean> => {
    const res = await api.sendSupportMessage({
      subject: data.subject,
      content: data.content,
      priority: data.priority,
      attachmentIds: data.attachmentIds,
    });
    if (!res.success) return false;
    setSent(true);
    setOpen(false);
    return true;
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-fg inline-flex items-center gap-1.5">
        <LifeBuoy className="w-4 h-4 text-brand" />
        Still stuck?
      </h2>
      <p className="mt-2 text-xs text-fg-muted">
        {canMessage
          ? <>Send the <span className="font-medium">{aliasLocalPart(supportAlias)}</span> desk a message. Replies arrive in <Link href="/dashboard/messages" className="action-link">Messages</Link>.</>
          : <>Your account can&apos;t send messages. Ask an administrator of your organization to grant <code className="text-2xs">messages:read</code>, or to contact support for you.</>}
      </p>
      {canMessage && (
        <Button className="mt-3 w-full" onClick={() => { setSent(false); setOpen(true); }} data-testid="help-contact-support">
          Contact support
        </Button>
      )}
      {sent && (
        <p className="mt-2 text-xs text-success" data-testid="help-support-sent">
          Message sent — the reply arrives in <Link href="/dashboard/messages" className="action-link">Messages</Link>.
        </p>
      )}

      {/* The other outbound path a stuck reader needs: they may be in the wrong
          organization entirely (a personal org auto-created at social signup)
          while their team already has one. */}
      <div className="mt-4 pt-3 border-t border-default">
        <Link href="/dashboard/onboarding" className="text-xs action-link inline-flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5" />
          Join an organization
        </Link>
        <p className="mt-1 text-2xs text-fg-subtle">
          Find organizations your email domain can join, or check a request you already sent.
        </p>
      </div>

      {open && (
        <ComposeModal
          isOpen={open}
          onClose={() => setOpen(false)}
          onSend={handleSend}
          canWrite={false}
          isSuperAdmin={false}
          supportAlias={supportAlias}
          supportAliases={supportAliases}
        />
      )}
    </Card>
  );
}
