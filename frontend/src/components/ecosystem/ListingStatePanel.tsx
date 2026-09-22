// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Archive, Ban, LayoutList, RotateCcw, Stamp } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { LISTING_STATE_COLORS, LISTING_STATE_LABELS } from '@/lib/ecosystem';
import type { ListingState, ListingVersionView, ListingView } from '@/types/ecosystem';
import { EcosystemActionDialog } from './EcosystemActionDialog';

interface Props {
  can: (permission: string) => boolean;
}

type SettableState = 'listed' | 'unmaintained' | 'suspended';

type Action =
  | { kind: 'resign' }
  | { kind: 'state'; listing: ListingView; state: SettableState }
  | { kind: 'yank' | 'unyank' | 'deprecate' | 'undeprecate'; listing: ListingView; version: ListingVersionView };

const STATE_ACTION_COPY: Record<SettableState, { label: string; details: string }> = {
  listed: { label: 'Relist', details: 'The listing returns to the directory.' },
  unmaintained: { label: 'Mark unmaintained', details: 'Installers see an unmaintained banner and a warning; installed versions keep resolving.' },
  suspended: { label: 'Suspend', details: 'The listing leaves the directory and its versions stop resolving for new synths.' },
};

/**
 * Ecosystem console → Listings (`plugins:moderate`): set a
 * listing's state, yank / unyank versions and deprecate / clear them. Lifting a suspension and
 * unyanking are two-person — they create a request for a second approver.
 * Every write is step-up gated.
 */
export function ListingStatePanel({ can }: Props) {
  const toast = useToast();
  const mayModerate = can('plugins:moderate');
  const [state, setState] = useState<ListingState | ''>('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q, 300);
  const [action, setAction] = useState<Action | null>(null);

  const listingsQ = useFetch(async (signal) => {
    const res = await api.listEcosystemListings({
      ...(state ? { state } : {}),
      ...(debouncedQ.trim() ? { q: debouncedQ.trim() } : {}),
    }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load listings');
    return res.data.listings;
  }, [state, debouncedQ]);
  const listings = listingsQ.data ?? [];

  const resign = async (reason: string, token?: string) => {
    const res = await api.resignAllPublishedImages(reason, token);
    toast.success(`Queued a re-sign of ${res.data?.queued ?? 0} published image${res.data?.queued === 1 ? '' : 's'}`);
  };

  const run = async (reason: string, token?: string) => {
    if (!action || action.kind === 'resign') return;
    const l = action.listing;
    if (action.kind === 'state') {
      const res = await api.setListingState(l.id, action.state, reason, token);
      toast.success(res.data?.request
        ? `Lifting the suspension of ${l.name} now waits for a second approver`
        : `${l.name} is now ${LISTING_STATE_LABELS[action.state].toLowerCase()}`);
    } else if (action.kind === 'yank') {
      await api.yankListingVersion(l.id, action.version.version, reason, token);
      toast.success(`Yanked ${l.name} v${action.version.version}`);
    } else if (action.kind === 'deprecate') {
      await api.setListingVersionDeprecation(l.id, action.version.version, reason ? { message: reason } : {}, token);
      toast.success(`Deprecated ${l.name} v${action.version.version}`);
    } else if (action.kind === 'undeprecate') {
      await api.setListingVersionDeprecation(l.id, action.version.version, { deprecated: false }, token);
      toast.success(`Cleared the deprecation of ${l.name} v${action.version.version}`);
    } else {
      await api.requestUnyankListingVersion(l.id, action.version.version, reason, token);
      toast.success(`Unyanking ${l.name} v${action.version.version} now waits for a second approver`);
    }
    void listingsQ.refetch();
  };

  return (
    <SectionCard
      icon={LayoutList}
      title="Listings"
      description="Listing state and version yanks across the ecosystem."
      actions={mayModerate ? (
        <Button variant="secondary" size="sm" onClick={() => setAction({ kind: 'resign' })}>
          <Stamp className="w-4 h-4 mr-1" aria-hidden />Re-sign all published images
        </Button>
      ) : undefined}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Search" className="min-w-[14rem]">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Listing or publisher" />
          </FormField>
          <FormField label="State" className="min-w-[10rem]">
            <Select value={state} onChange={(e) => setState(e.target.value as ListingState | '')}>
              <option value="">All states</option>
              {(Object.keys(LISTING_STATE_LABELS) as ListingState[]).map((s) => (
                <option key={s} value={s}>{LISTING_STATE_LABELS[s]}</option>
              ))}
            </Select>
          </FormField>
        </div>

        {listingsQ.loading && !listingsQ.data ? (
          <Skeleton className="h-24 w-full" />
        ) : listingsQ.error ? (
          <RetryError message={formatError(listingsQ.error, 'Failed to load listings')} onRetry={listingsQ.refetch} />
        ) : listings.length === 0 ? (
          <EmptyState compact icon={LayoutList} title="No listings match" />
        ) : (
          <ul className="space-y-3" aria-label="Ecosystem listings">
            {listings.map((l) => (
              <li key={l.id} className="rounded-lg border border-default p-3 space-y-2" data-testid={`eco-listing-${l.name}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono font-medium text-fg">{l.publisherHandle}/{l.name}</span>
                    <TrustTierBadge tier={l.publisherTier} compact />
                    <Badge color={LISTING_STATE_COLORS[l.state]}>{LISTING_STATE_LABELS[l.state]}</Badge>
                    {l.pausedAt && <Badge color="yellow">Paused by publisher</Badge>}
                  </div>
                  {mayModerate && l.state !== 'transferred' && (
                    <div className="flex flex-wrap gap-1">
                      {(['listed', 'unmaintained', 'suspended'] as const).filter((s) => s !== l.state).map((s) => (
                        <Button
                          key={s}
                          variant={s === 'suspended' ? 'danger-outline' : 'secondary'}
                          size="xs"
                          onClick={() => setAction({ kind: 'state', listing: l, state: s })}
                          aria-label={`${STATE_ACTION_COPY[s].label}: ${l.name}`}
                        >
                          {STATE_ACTION_COPY[s].label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
                {l.versions && l.versions.length > 0 && (
                  <ul className="flex flex-wrap gap-2 text-xs">
                    {l.versions.map((v) => (
                      <li key={v.id} className="inline-flex items-center gap-1 rounded-md border border-default px-2 py-1">
                        <span className="font-mono">{v.version}</span>
                        {v.yankedAt && <Badge color="red">Yanked</Badge>}
                        {v.pausedAt && <Badge color="yellow">Paused</Badge>}
                        {v.deprecatedAt && <span title={v.deprecationMessage ?? undefined}><Badge color="yellow">Deprecated</Badge></span>}
                        {mayModerate && (v.yankedAt ? (
                          <Button variant="ghost" size="xs" onClick={() => setAction({ kind: 'unyank', listing: l, version: v })} aria-label={`Request unyank of ${l.name} v${v.version}`}>
                            <RotateCcw className="w-3 h-3" aria-hidden /> Unyank
                          </Button>
                        ) : (
                          <Button variant="ghost" size="xs" onClick={() => setAction({ kind: 'yank', listing: l, version: v })} aria-label={`Yank ${l.name} v${v.version}`}>
                            <Ban className="w-3 h-3" aria-hidden /> Yank
                          </Button>
                        ))}
                        {mayModerate && (v.deprecatedAt ? (
                          <Button variant="ghost" size="xs" onClick={() => setAction({ kind: 'undeprecate', listing: l, version: v })} aria-label={`Clear the deprecation of ${l.name} v${v.version}`}>
                            <RotateCcw className="w-3 h-3" aria-hidden /> Undeprecate
                          </Button>
                        ) : (
                          <Button variant="ghost" size="xs" onClick={() => setAction({ kind: 'deprecate', listing: l, version: v })} aria-label={`Deprecate ${l.name} v${v.version}`}>
                            <Archive className="w-3 h-3" aria-hidden /> Deprecate
                          </Button>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {action?.kind === 'resign' && (
        <EcosystemActionDialog
          title="Re-sign all published images?"
          action="Queue a trust re-sign of every public/* plugin image"
          details={<p>Use this after rotating the plugin-signing key (see the secret-rotation runbook). Every published image gets a fresh signature; installs keep resolving meanwhile.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp
          onSubmit={resign}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'state' && (
        <EcosystemActionDialog
          title={`${STATE_ACTION_COPY[action.state].label}: ${action.listing.name}?`}
          action={`${STATE_ACTION_COPY[action.state].label} ${action.listing.publisherHandle}/${action.listing.name}`}
          details={(
            <p>
              {STATE_ACTION_COPY[action.state].details}
              {action.listing.state === 'suspended' && ' Lifting a suspension is two-person: this creates a request for a second approver.'}
            </p>
          )}
          reasonLabel="Reason"
          reasonRequired
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'yank' && (
        <EcosystemActionDialog
          title={`Yank ${action.listing.name} v${action.version.version}?`}
          action={`Yank ${action.listing.publisherHandle}/${action.listing.name} v${action.version.version}`}
          details={<p>The version stops resolving for new synths; pinned consumers get an error naming the reason. Unyanking takes two approvers.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'deprecate' && (
        <EcosystemActionDialog
          title={`Deprecate ${action.listing.name} v${action.version.version}?`}
          action={`Deprecate ${action.listing.publisherHandle}/${action.listing.name} v${action.version.version}`}
          details={<p>The version keeps resolving; every lookup of it warns with the message.</p>}
          reasonLabel="Deprecation message (optional)"
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'undeprecate' && (
        <EcosystemActionDialog
          title={`Clear the deprecation of ${action.listing.name} v${action.version.version}?`}
          action={`Clear the deprecation of ${action.listing.publisherHandle}/${action.listing.name} v${action.version.version}`}
          details={action.version.deprecationMessage ? <p>Current message: {action.version.deprecationMessage}</p> : undefined}
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'unyank' && (
        <EcosystemActionDialog
          title={`Request unyank of ${action.listing.name} v${action.version.version}?`}
          action={`Request unyanking ${action.listing.publisherHandle}/${action.listing.name} v${action.version.version}`}
          details={<p>Two-person action: this creates a request that a second approver must confirm.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
    </SectionCard>
  );
}
