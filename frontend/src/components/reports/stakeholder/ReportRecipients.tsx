// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { MailCheck, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { Input } from '@/components/ui/Input';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type { ReportPolicy, ReportRecipient } from '@/lib/api/domains/stakeholder-reports';
import { blockedLabel } from './ReportDefinitionForm';

interface ReportRecipientsProps {
  recipients: ReportRecipient[];
  policy: ReportPolicy | null;
  /** `reports:author` — may add and remove addresses. */
  canAuthor: boolean;
  readOnly?: boolean;
  onChanged: () => void;
}

/**
 * The distribution list, with each address's real delivery state.
 *
 * The state is the point. A list that shows an address but not that it has never
 * confirmed is how a report silently reaches nobody — so every row says whether a
 * send would actually be attempted, and why not when it wouldn't.
 */
export function ReportRecipients({ recipients, policy, canAuthor, readOnly = false, onChanged }: ReportRecipientsProps) {
  const form = useFormState();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    await form.run(
      async () => {
        const res = await api.addReportRecipient({
          email: email.trim(),
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        });
        if (!res.success || !res.data) throw new Error('Could not add the address');
        return res.data;
      },
      {
        onSuccess: (result) => {
          setEmail('');
          setDisplayName('');
          setNotice(
            result.pendingApproval
              ? 'Added, and waiting for an administrator to approve it. Nothing is delivered until they do.'
              : result.recipient.verified
                ? 'Added. They are a member of this organization, so no confirmation is needed.'
                : 'Added. They will get a confirmation email — nothing is delivered until they confirm.',
          );
          onChanged();
        },
      },
    );
  };

  const resend = async (id: string) => {
    setNotice(null);
    await form.run(
      async () => { await api.resendReportRecipientVerification(id); },
      { onSuccess: () => { setNotice('Confirmation sent again.'); onChanged(); } },
    );
  };

  const remove = async (id: string) => {
    setNotice(null);
    await form.run(
      async () => { await api.removeReportRecipient(id); },
      { onSuccess: onChanged },
    );
  };

  const domains = policy?.recipientDomains ?? null;

  return (
    <div className="space-y-4">
      {canAuthor && (
        <Card>
          <form onSubmit={add} className="space-y-3">
            <h3 className="h3">Add a recipient</h3>
            <p className="text-sm text-fg-muted">
              {domains && domains.length > 0
                ? <>Members of this organization, plus addresses at {domains.join(', ')}.</>
                : <>Members of this organization only. An administrator can allow specific external domains in reporting settings.</>}
              {policy?.requireApproval && ' An external address also needs an administrator to approve it.'}
            </p>
            <ErrorAlert message={form.error} onDismiss={form.reset} />
            {notice && <InfoAlert message={notice} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Email" required>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={320} />
              </FormField>
              <FormField label="Name" hint="Optional — how they appear in the list.">
                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={200} />
              </FormField>
            </div>
            <Button type="submit" size="sm" loading={form.loading} readOnly={readOnly}>Add</Button>
          </form>
        </Card>
      )}

      <Card>
        <h3 className="h3 mb-2">Recipients</h3>
        {recipients.length === 0 ? (
          <EmptyState
            compact
            icon={MailCheck}
            title="No recipients yet"
            description="Add the people who should receive these reports. An external address confirms by email before anything reaches it."
          />
        ) : (
          <ul className="divide-y divide-default">
            {recipients.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">{r.displayName ? `${r.displayName} · ${r.email}` : r.email}</p>
                  <p className="text-xs text-fg-muted">
                    {r.deliverable
                      ? 'Deliverable'
                      : `Not delivered — ${blockedLabel(r.blockedReason)}`}
                    {r.bounceCount > 0 && ` · ${r.bounceCount} bounce${r.bounceCount === 1 ? '' : 's'}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {r.deliverable ? <Badge color="green">Ready</Badge>
                    : r.unsubscribed ? <Badge color="gray">Unsubscribed</Badge>
                      : !r.verified ? <Badge color="yellow">Awaiting confirmation</Badge>
                        : <Badge color="red">Bouncing</Badge>}
                  {canAuthor && !r.verified && !r.unsubscribed && (
                    <Button size="xs" variant="secondary" onClick={() => resend(r.id)} loading={form.loading} readOnly={readOnly}>
                      Resend
                    </Button>
                  )}
                  {canAuthor && (
                    <Button size="xs" variant="danger" onClick={() => remove(r.id)} readOnly={readOnly}>
                      <Trash2 className="w-3 h-3" aria-hidden="true" />
                      <span className="sr-only">Remove {r.email}</span>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {recipients.some((r) => r.unsubscribed) && (
          <p className="mt-3 text-xs text-fg-muted">
            An unsubscribe is honoured across every report in this organization, and removing and re-adding the
            address does not undo it.
          </p>
        )}
      </Card>
    </div>
  );
}
