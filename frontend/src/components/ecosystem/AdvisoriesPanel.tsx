// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Check, FilePenLine, Plus, ShieldAlert, Undo2, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import {
  ADVISORY_SOURCE_LABELS, ADVISORY_STATE_COLORS, ADVISORY_STATE_LABELS, severityColor, severityLabel,
} from '@/lib/advisories';
import { formatError } from '@/lib/constants';
import type { AdvisoryInput, AdvisoryState, AdvisoryView } from '@/types/ecosystem';
import { AdvisoryFacts } from './AdvisoryFacts';
import { AdvisoryFormDialog, type AdvisoryFormValue } from './AdvisoryFormDialog';
import { EcosystemActionDialog } from './EcosystemActionDialog';

interface Props {
  can: (permission: string) => boolean;
}

type Action =
  | { kind: 'new-form' }
  | { kind: 'edit-form'; advisory: AdvisoryView }
  | { kind: 'create'; value: AdvisoryFormValue }
  | { kind: 'save'; advisory: AdvisoryView; value: AdvisoryInput }
  | { kind: 'publish' | 'discard' | 'withdraw'; advisory: AdvisoryView };

const STATES: AdvisoryState[] = ['draft', 'published', 'withdrawn'];

/**
 * Ecosystem console → Advisories (plan W8, `plugins:moderate`). Drafts come
 * from publishers, moderators, the nightly CVE rescan and reviews; PUBLISHING a
 * draft is approving its `advisory` request (which notifies every installing
 * org), DISCARDING it is rejecting that request. Published advisories can be
 * withdrawn, which clears the lookup warning / block. Writes are step-up gated
 * (the reject route, like the queue's, is not).
 */
export function AdvisoriesPanel({ can }: Props) {
  const toast = useToast();
  const mayModerate = can('plugins:moderate');
  const [state, setState] = useState<AdvisoryState>('draft');
  const [action, setAction] = useState<Action | null>(null);
  const close = () => setAction(null);

  const advisoriesQ = useFetch(async (signal) => {
    const res = await api.listEcosystemAdvisories({ state }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load advisories');
    return res.data.advisories;
  }, [state]);

  const listingsQ = useFetch(async (signal) => {
    if (action?.kind !== 'new-form') return null;
    const res = await api.listEcosystemListings(undefined, { signal });
    return res.data?.listings ?? [];
  }, [action?.kind === 'new-form']);

  const run = async (text: string, token?: string) => {
    if (!action) return;
    if (action.kind === 'create') {
      await api.createEcosystemAdvisory({ listingId: action.value.listingId, ...action.value.advisory }, token);
      toast.success('Draft advisory created');
    } else if (action.kind === 'save') {
      await api.updateEcosystemAdvisory(action.advisory.id, action.value, token);
      toast.success('Draft advisory saved');
    } else if (action.kind === 'publish') {
      await api.approveEcosystemRequest(action.advisory.requestId as string, text || undefined, token);
      toast.success(`Published the advisory for ${action.advisory.listingName}; installers are being notified`);
    } else if (action.kind === 'discard') {
      await api.rejectEcosystemRequest(action.advisory.requestId as string, text);
      toast.success('Draft advisory discarded');
    } else if (action.kind === 'withdraw') {
      await api.withdrawEcosystemAdvisory(action.advisory.id, text, token);
      toast.success(`Withdrew the advisory for ${action.advisory.listingName}`);
    }
    advisoriesQ.refetch();
  };

  const advisories = advisoriesQ.data ?? [];
  const subject = (a: AdvisoryView) => `${a.publisherHandle}/${a.listingName} (${severityLabel(a.severity).toLowerCase()})`;

  return (
    <SectionCard
      icon={ShieldAlert}
      title="Security advisories"
      description="Draft, publish and withdraw advisories. Publishing notifies every organization that installed an affected version."
      actions={mayModerate ? (
        <Button size="sm" onClick={() => setAction({ kind: 'new-form' })}>
          <Plus className="w-4 h-4 mr-1" aria-hidden />New draft
        </Button>
      ) : undefined}
    >
      <div className="space-y-4">
        <FormField label="State" className="max-w-[12rem]">
          <Select value={state} onChange={(e) => setState(e.target.value as AdvisoryState)}>
            {STATES.map((s) => <option key={s} value={s}>{ADVISORY_STATE_LABELS[s]}</option>)}
          </Select>
        </FormField>

        {advisoriesQ.loading && !advisoriesQ.data ? (
          <Skeleton className="h-24 w-full" />
        ) : advisoriesQ.error ? (
          <RetryError message={formatError(advisoriesQ.error, 'Failed to load advisories')} onRetry={advisoriesQ.refetch} />
        ) : advisories.length === 0 ? (
          <EmptyState compact icon={ShieldAlert} title={`No ${ADVISORY_STATE_LABELS[state].toLowerCase()} advisories`} />
        ) : (
          <ul className="space-y-3" aria-label="Ecosystem advisories">
            {advisories.map((a) => (
              <li key={a.id} className="rounded-lg border border-default p-3 space-y-2" data-testid={`eco-advisory-${a.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium text-fg">{a.publisherHandle}/{a.listingName}</span>
                      <Badge color={severityColor(a.severity)}>{severityLabel(a.severity)}</Badge>
                      <Badge color={ADVISORY_STATE_COLORS[a.state]}>{ADVISORY_STATE_LABELS[a.state]}</Badge>
                      <Badge color="indigo">{ADVISORY_SOURCE_LABELS[a.source]}</Badge>
                    </div>
                    <p className="text-sm text-fg">{a.summary}</p>
                  </div>
                  {mayModerate && a.state === 'draft' && (
                    <div className="flex flex-wrap gap-1">
                      <Button variant="secondary" size="xs" onClick={() => setAction({ kind: 'edit-form', advisory: a })} aria-label={`Edit the draft for ${a.listingName}`}>
                        <FilePenLine className="w-3.5 h-3.5 mr-1" aria-hidden />Edit
                      </Button>
                      <Button
                        size="xs"
                        onClick={() => setAction({ kind: 'publish', advisory: a })}
                        disabled={!a.requestId}
                        title={a.requestId ? undefined : 'This draft has no open request'}
                        aria-label={`Publish the advisory for ${a.listingName}`}
                      >
                        <Check className="w-3.5 h-3.5 mr-1" aria-hidden />Publish
                      </Button>
                      <Button
                        variant="danger-outline"
                        size="xs"
                        onClick={() => setAction({ kind: 'discard', advisory: a })}
                        disabled={!a.requestId}
                        aria-label={`Discard the draft for ${a.listingName}`}
                      >
                        <X className="w-3.5 h-3.5 mr-1" aria-hidden />Discard
                      </Button>
                    </div>
                  )}
                  {mayModerate && a.state === 'published' && (
                    <Button variant="danger-outline" size="xs" onClick={() => setAction({ kind: 'withdraw', advisory: a })} aria-label={`Withdraw the advisory for ${a.listingName}`}>
                      <Undo2 className="w-3.5 h-3.5 mr-1" aria-hidden />Withdraw
                    </Button>
                  )}
                </div>
                <AdvisoryFacts advisory={a} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {action?.kind === 'new-form' && (
        <AdvisoryFormDialog
          title="New draft advisory"
          confirmLabel="Continue"
          listings={(listingsQ.data ?? []).map((l) => ({ id: l.id, label: `${l.publisherHandle}/${l.name}` }))}
          listingsLoading={listingsQ.loading && !listingsQ.data}
          intro={<p>The draft stays private until you publish it from the drafts list.</p>}
          onSubmit={async (value) => setAction({ kind: 'create', value })}
          onClose={close}
        />
      )}
      {action?.kind === 'edit-form' && (
        <AdvisoryFormDialog
          title="Edit draft advisory"
          confirmLabel="Continue"
          initial={action.advisory}
          onSubmit={async ({ advisory }) => setAction({ kind: 'save', advisory: action.advisory, value: advisory })}
          onClose={close}
        />
      )}
      {action?.kind === 'create' && (
        <EcosystemActionDialog
          title="Create this draft?"
          action={`Create a ${severityLabel(action.value.advisory.severity).toLowerCase()} draft advisory: ${action.value.advisory.summary}`}
          stepUp
          onSubmit={run}
          onClose={close}
        />
      )}
      {action?.kind === 'save' && (
        <EcosystemActionDialog
          title="Save this draft?"
          action={`Save the draft for ${action.advisory.publisherHandle}/${action.advisory.listingName}`}
          stepUp
          onSubmit={run}
          onClose={close}
        />
      )}
      {action?.kind === 'publish' && (
        <EcosystemActionDialog
          title="Publish this advisory?"
          action={`Publish ${subject(action.advisory)}`}
          details={<p>The directory shows it, lookups of the affected versions warn (or block, per each org’s policy), and every installing organization is notified.</p>}
          reasonLabel="Note (optional)"
          stepUp
          confirmLabel="Publish"
          onSubmit={run}
          onClose={close}
        />
      )}
      {action?.kind === 'discard' && (
        <EcosystemActionDialog
          title="Discard this draft?"
          action={`Discard ${subject(action.advisory)}`}
          details={<p>The draft’s request is rejected; the publisher sees the reason. Nothing was ever public.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp={false}
          tone="danger"
          confirmLabel="Discard"
          onSubmit={run}
          onClose={close}
        />
      )}
      {action?.kind === 'withdraw' && (
        <EcosystemActionDialog
          title="Withdraw this advisory?"
          action={`Withdraw ${subject(action.advisory)}`}
          details={<p>Lookups stop warning and blocking on it, and installing organizations are notified of the withdrawal.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp
          tone="danger"
          confirmLabel="Withdraw"
          onSubmit={run}
          onClose={close}
        />
      )}
    </SectionCard>
  );
}
