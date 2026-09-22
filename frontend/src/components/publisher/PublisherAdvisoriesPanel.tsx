// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { EyeOff, Plus, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { AdvisoryFacts } from '@/components/ecosystem/AdvisoryFacts';
import { AdvisoryFormDialog } from '@/components/ecosystem/AdvisoryFormDialog';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import {
  ADVISORY_SOURCE_LABELS, ADVISORY_STATE_COLORS, ADVISORY_STATE_LABELS, severityColor, severityLabel,
} from '@/lib/advisories';
import { formatError } from '@/lib/constants';
import type { AdvisoryView } from '@/types/ecosystem';
import { describePublishError } from './PublishRequestForm';

/**
 * The publisher's security advisories (plan W8, `publishers:manage`). A
 * publisher only ever REQUESTS an advisory: it lands as a private draft the
 * system org publishes (or discards). Drafts the nightly CVE rescan created for
 * the publisher's listings show up here too.
 */
export function PublisherAdvisoriesPanel({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const advisoriesQ = useFetch(async (signal) => {
    const res = await api.listPublisherAdvisories({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load advisories');
    return res.data.advisories;
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<AdvisoryView | null>(null);
  const [busy, setBusy] = useState(false);

  const listingsQ = useFetch(async (signal) => {
    if (!submitting) return null;
    const res = await api.listPublisherListings({ signal });
    return res.data?.listings ?? [];
  }, [submitting]);

  const withdraw = async () => {
    if (!withdrawing?.requestId) return;
    setBusy(true);
    try {
      await api.withdrawPublishRequest(withdrawing.requestId);
      toast.success('Advisory request withdrawn');
      setWithdrawing(null);
      advisoriesQ.refetch();
    } catch (err) {
      toast.error(formatError(err, 'Could not withdraw the request'));
    } finally {
      setBusy(false);
    }
  };

  const advisories = advisoriesQ.data ?? [];

  return (
    <SectionCard
      icon={ShieldAlert}
      title="Security advisories"
      description="Advisories warn every organization that installed an affected version. You submit a draft; the ecosystem team publishes it."
      actions={canManage ? (
        <Button size="sm" onClick={() => setSubmitting(true)}>
          <Plus className="w-4 h-4 mr-1" aria-hidden />Submit advisory
        </Button>
      ) : undefined}
    >
      {advisoriesQ.loading && !advisoriesQ.data ? (
        <Skeleton className="h-24 w-full" />
      ) : advisoriesQ.error ? (
        <RetryError message={formatError(advisoriesQ.error, 'Failed to load advisories')} onRetry={advisoriesQ.refetch} />
      ) : advisories.length === 0 ? (
        <EmptyState compact icon={ShieldAlert} title="No advisories" description="None of your listings has an advisory." />
      ) : (
        <ul className="space-y-3" aria-label="Advisories">
          {advisories.map((a) => (
            <li key={a.id} className="rounded-lg border border-default p-3 space-y-2" data-testid={`advisory-${a.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium text-fg">{a.listingName}</span>
                    <Badge color={severityColor(a.severity)}>{severityLabel(a.severity)}</Badge>
                    <Badge color={ADVISORY_STATE_COLORS[a.state]}>{ADVISORY_STATE_LABELS[a.state]}</Badge>
                    {a.source !== 'publisher' && <Badge color="indigo">{ADVISORY_SOURCE_LABELS[a.source]}</Badge>}
                  </div>
                  <p className="text-sm text-fg">{a.summary}</p>
                </div>
                {canManage && a.state === 'draft' && a.requestId && (
                  <Button variant="ghost" size="xs" onClick={() => setWithdrawing(a)} aria-label={`Withdraw the advisory request for ${a.listingName}`}>
                    Withdraw request
                  </Button>
                )}
              </div>
              <AdvisoryFacts advisory={a} />
              {a.state === 'draft' && (
                <p className="inline-flex items-center gap-1 text-xs text-warning-strong">
                  <EyeOff className="w-3.5 h-3.5" aria-hidden />
                  Private draft — not public until the ecosystem team publishes it.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {submitting && (
        <AdvisoryFormDialog
          title="Submit a security advisory"
          confirmLabel="Submit request"
          listings={(listingsQ.data ?? []).map((l) => ({ id: l.id, label: l.name }))}
          listingsLoading={listingsQ.loading && !listingsQ.data}
          intro={<p>The advisory is a private draft until the ecosystem team publishes it. Publishing notifies every organization that installed an affected version.</p>}
          onSubmit={async ({ listingId, advisory }) => {
            try {
              await api.submitPublishRequest({ kind: 'advisory', listingId, advisory });
            } catch (err) {
              throw new Error(describePublishError(err).message);
            }
            toast.success('Advisory submitted. The ecosystem team will review it.');
            setSubmitting(false);
            advisoriesQ.refetch();
          }}
          onClose={() => setSubmitting(false)}
        />
      )}

      {withdrawing && (
        <ConfirmDialog
          title="Withdraw this advisory request?"
          confirmLabel="Withdraw"
          loading={busy}
          onConfirm={() => void withdraw()}
          onCancel={() => setWithdrawing(null)}
        >
          <p>The draft advisory for {withdrawing.listingName} is discarded and never published.</p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
