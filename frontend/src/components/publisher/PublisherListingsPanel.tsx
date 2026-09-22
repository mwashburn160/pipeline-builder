// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Archive, ArrowRightLeft, Ban, FilePenLine, Globe, Package, Pause, Play } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { EcosystemActionDialog } from '@/components/ecosystem/EcosystemActionDialog';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { LISTING_STATE_COLORS, LISTING_STATE_LABELS } from '@/lib/ecosystem';
import { pluginPagePath } from '@/lib/public-directory/links';
import type { ListingVersionView, ListingView } from '@/types/ecosystem';
import { RequestListingUpdateDialog } from './RequestListingUpdateDialog';
import { describePublishError } from './PublishRequestForm';

type Pending =
  | { kind: 'pause'; listing: ListingView; version?: ListingVersionView }
  | { kind: 'unpause'; listing: ListingView; version?: ListingVersionView }
  | { kind: 'yank'; listing: ListingView; version: ListingVersionView }
  | { kind: 'deprecate'; listing: ListingView; version: ListingVersionView }
  | { kind: 'transfer'; listing: ListingView }
  | { kind: 'update'; listing: ListingView };

const DEPRECATION_MESSAGE_MAX = 500;

interface Props {
  /** `plugins:publish`: pause, deprecate, unpause, yank and listing-update requests. */
  canPublish: boolean;
  /** `publishers:manage`: transfer requests. */
  canManage: boolean;
}

/**
 * The publisher's listings, each with its versions and their state (plan §3.1,
 * §3.4). Pausing is immediate and only narrows the publisher's own reach, so
 * it's a plain confirm; everything else — unpause, yank, listing update,
 * transfer — is a REQUEST the system org decides.
 */
export function PublisherListingsPanel({ canPublish, canManage }: Props) {
  const toast = useToast();
  const listingsQ = useFetch(async (signal) => {
    const res = await api.listPublisherListings({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load listings');
    return res.data.listings;
  }, []);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [targetHandle, setTargetHandle] = useState('');

  const close = () => { setPending(null); setTargetHandle(''); };

  const pause = async () => {
    if (pending?.kind !== 'pause') return;
    setBusy(true);
    try {
      await api.pauseListing(pending.listing.id, pending.version?.version);
      toast.success(pending.version ? `Paused ${pending.listing.name} v${pending.version.version}` : `Paused ${pending.listing.name}`);
      close();
      listingsQ.refetch();
    } catch (err) {
      toast.error(formatError(err, 'Could not pause'));
    } finally {
      setBusy(false);
    }
  };

  const requested = (what: string) => {
    toast.success(`${what} requested. The ecosystem team will review it.`);
    listingsQ.refetch();
  };

  const submitOrExplain = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      throw new Error(describePublishError(err).message);
    }
  };

  const listings = listingsQ.data ?? [];

  return (
    <SectionCard icon={Package} title="Listings" description="Your plugins in the public directory, and their versions.">
      {listingsQ.loading && !listingsQ.data ? (
        <Skeleton className="h-24 w-full" />
      ) : listingsQ.error ? (
        <RetryError message={formatError(listingsQ.error, 'Failed to load listings')} onRetry={listingsQ.refetch} />
      ) : listings.length === 0 ? (
        <EmptyState
          compact
          icon={Package}
          title="No listings yet"
          description="Submit a new-listing request from the Publish tab. Listings appear here once the ecosystem team approves them."
        />
      ) : (
        <ul className="space-y-4" aria-label="Listings">
          {listings.map((l) => (
            <li key={l.id} className="rounded-lg border border-default p-4 space-y-3" data-testid={`listing-${l.name}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-fg">{l.name}</span>
                    <TrustTierBadge tier={l.publisherTier} compact />
                    <Badge color={LISTING_STATE_COLORS[l.state]}>{LISTING_STATE_LABELS[l.state]}</Badge>
                    {l.pausedAt && <Badge color="yellow">Paused</Badge>}
                    {(l.openRequests ?? 0) > 0 && (
                      <Badge color="blue">{l.openRequests} open request{l.openRequests === 1 ? '' : 's'}</Badge>
                    )}
                  </div>
                  {l.summary && <p className="text-sm text-fg-muted">{l.summary}</p>}
                  {l.state === 'listed' && (
                    <Link href={pluginPagePath(l.publisherHandle, l.name)} className="action-link inline-flex items-center gap-1 text-xs">
                      <Globe className="w-3.5 h-3.5" aria-hidden /> View public page
                    </Link>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {canPublish && (l.pausedAt ? (
                    <Button variant="secondary" size="xs" onClick={() => setPending({ kind: 'unpause', listing: l })} aria-label={`Request unpause of ${l.name}`}>
                      <Play className="w-3.5 h-3.5 mr-1" aria-hidden />Request unpause
                    </Button>
                  ) : (
                    <Button variant="secondary" size="xs" onClick={() => setPending({ kind: 'pause', listing: l })} aria-label={`Pause ${l.name}`}>
                      <Pause className="w-3.5 h-3.5 mr-1" aria-hidden />Pause
                    </Button>
                  ))}
                  {canPublish && (
                    <Button variant="secondary" size="xs" onClick={() => setPending({ kind: 'update', listing: l })} aria-label={`Request an update of ${l.name}`}>
                      <FilePenLine className="w-3.5 h-3.5 mr-1" aria-hidden />Request update
                    </Button>
                  )}
                  {canManage && (
                    <Button variant="secondary" size="xs" onClick={() => setPending({ kind: 'transfer', listing: l })} aria-label={`Request transfer of ${l.name}`}>
                      <ArrowRightLeft className="w-3.5 h-3.5 mr-1" aria-hidden />Transfer
                    </Button>
                  )}
                </div>
              </div>

              {l.versions && l.versions.length > 0 && (
                <table className="w-full text-xs">
                  <thead className="text-left text-fg-subtle">
                    <tr><th className="py-1 font-medium">Version</th><th className="py-1 font-medium">Published</th><th className="py-1 font-medium">Status</th><th className="py-1"><span className="sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody className="divide-y divide-default">
                    {l.versions.map((v) => (
                      <tr key={v.id} data-testid={`version-${l.name}-${v.version}`}>
                        <td className="py-1.5 font-mono">{v.version}{v.breaking && <span className="ml-1 text-warning-strong">(breaking)</span>}</td>
                        <td className="py-1.5 text-fg-muted">{new Date(v.publishedAt).toLocaleDateString()}</td>
                        <td className="py-1.5">
                          <span className="inline-flex flex-wrap gap-1">
                            {v.yankedAt ? <Badge color="red">Yanked</Badge> : v.pausedAt ? <Badge color="yellow">Paused</Badge> : <Badge color="green">Available</Badge>}
                            {v.deprecatedAt && <Badge color="yellow">Deprecated</Badge>}
                            {(v.vulnCritical ?? 0) > 0 && <Badge color="red">{v.vulnCritical} critical</Badge>}
                            {(v.vulnHigh ?? 0) > 0 && <Badge color="yellow">{v.vulnHigh} high</Badge>}
                          </span>
                          {v.yankReason && <span className="block text-fg-muted">{v.yankReason}</span>}
                          {v.deprecatedAt && v.deprecationMessage && <span className="block text-warning-strong">{v.deprecationMessage}</span>}
                        </td>
                        <td className="py-1.5 text-right">
                          {canPublish && !v.yankedAt && (
                            <span className="inline-flex gap-1">
                              {v.pausedAt ? (
                                <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'unpause', listing: l, version: v })} aria-label={`Request unpause of ${l.name} v${v.version}`}>
                                  Request unpause
                                </Button>
                              ) : (
                                <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'pause', listing: l, version: v })} aria-label={`Pause ${l.name} v${v.version}`}>
                                  Pause
                                </Button>
                              )}
                              <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'yank', listing: l, version: v })} aria-label={`Request yank of ${l.name} v${v.version}`}>
                                <Ban className="w-3.5 h-3.5 mr-1" aria-hidden />Request yank
                              </Button>
                              {!v.deprecatedAt && (
                                <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'deprecate', listing: l, version: v })} aria-label={`Deprecate ${l.name} v${v.version}`}>
                                  <Archive className="w-3.5 h-3.5 mr-1" aria-hidden />Deprecate
                                </Button>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}

      {pending?.kind === 'pause' && (
        <ConfirmDialog
          title={pending.version ? `Pause ${pending.listing.name} v${pending.version.version}?` : `Pause ${pending.listing.name}?`}
          confirmLabel="Pause"
          loading={busy}
          onConfirm={() => void pause()}
          onCancel={close}
        >
          <p>
            {pending.version
              ? 'The version is hidden and new installs stop resolving to it. Installs already on it, or pinned to it, keep working.'
              : 'The listing stops accepting new installs. Existing installs keep resolving.'}
          </p>
          <p>This takes effect immediately. Unpausing is a request the ecosystem team reviews.</p>
        </ConfirmDialog>
      )}

      {pending?.kind === 'unpause' && (
        <EcosystemActionDialog
          title="Request unpause"
          action={pending.version ? `Unpause ${pending.listing.name} v${pending.version.version}` : `Unpause ${pending.listing.name}`}
          reasonLabel="Reason (optional)"
          stepUp={false}
          confirmLabel="Submit request"
          onSubmit={(reason) => submitOrExplain(async () => {
            await api.submitPublishRequest({
              kind: 'unpause',
              listingId: pending.listing.id,
              ...(pending.version ? { version: pending.version.version } : {}),
              ...(reason ? { reason } : {}),
            });
            requested('Unpause');
          })}
          onClose={close}
        />
      )}

      {pending?.kind === 'yank' && (
        <EcosystemActionDialog
          title="Request a yank"
          action={`Yank ${pending.listing.name} v${pending.version.version}`}
          details={<p>A yanked version stops resolving for new synths; pinned consumers get an error explaining why. For an immediate effect while the request is reviewed, pause the version.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp={false}
          tone="danger"
          confirmLabel="Submit request"
          onSubmit={(reason) => submitOrExplain(async () => {
            await api.submitPublishRequest({ kind: 'yank', listingId: pending.listing.id, version: pending.version.version, reason });
            requested('Yank');
          })}
          onClose={close}
        />
      )}

      {pending?.kind === 'deprecate' && (
        <EcosystemActionDialog
          title="Deprecate this version?"
          action={`Deprecate ${pending.listing.name} v${pending.version.version}`}
          details={<p>The version keeps resolving, but every lookup of it warns with your message — point users at the version to move to. This takes effect immediately and can’t be undone from here.</p>}
          reasonLabel="Deprecation message"
          reasonHint={`Shown to everyone who resolves this version (at most ${DEPRECATION_MESSAGE_MAX} characters).`}
          reasonRequired
          stepUp={false}
          confirmLabel="Deprecate"
          onSubmit={async (message) => {
            if (message.length > DEPRECATION_MESSAGE_MAX) throw new Error(`The message can be at most ${DEPRECATION_MESSAGE_MAX} characters.`);
            await submitOrExplain(() => api.deprecateListingVersion(pending.listing.id, pending.version.version, message));
            toast.success(`Deprecated ${pending.listing.name} v${pending.version.version}`);
            listingsQ.refetch();
          }}
          onClose={close}
        />
      )}

      {pending?.kind === 'transfer' && (
        <EcosystemActionDialog
          title="Request a transfer"
          action={`Transfer ${pending.listing.name} to another publisher`}
          details={(
            <>
              <p>The receiving publisher must accept, and the ecosystem team approves, before the listing moves. History is kept.</p>
              <FormField label="Receiving publisher handle" required>
                <Input value={targetHandle} onChange={(e) => setTargetHandle(e.target.value)} placeholder="acme" />
              </FormField>
            </>
          )}
          reasonLabel="Reason (optional)"
          stepUp={false}
          confirmLabel="Submit request"
          onSubmit={(reason) => submitOrExplain(async () => {
            const handle = targetHandle.trim();
            if (!handle) throw new Error('Enter the receiving publisher handle.');
            await api.submitPublishRequest({
              kind: 'transfer',
              listingId: pending.listing.id,
              target: { targetPublisherHandle: handle },
              ...(reason ? { reason } : {}),
            });
            requested('Transfer');
          })}
          onClose={close}
        />
      )}

      {pending?.kind === 'update' && (
        <RequestListingUpdateDialog listing={pending.listing} onClose={close} onSubmitted={() => requested('Listing update')} />
      )}
    </SectionCard>
  );
}
