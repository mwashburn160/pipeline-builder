// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { BadgeCheck, Ban, RotateCcw, Users } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { RelativeTime } from '@/components/ui/RelativeTime';
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
import type { EcosystemPublisher } from '@/types/ecosystem';
import { EcosystemActionDialog } from './EcosystemActionDialog';
import { VerifiedEligibilityChecks } from './EcosystemEligibility';
import { QueueItemDetail } from './PublishQueuePanel';

interface Props {
  can: (permission: string) => boolean;
}

type Action =
  | { kind: 'suspend'; publisher: EcosystemPublisher }
  | { kind: 'unsuspend'; publisher: EcosystemPublisher }
  | { kind: 'tier'; publisher: EcosystemPublisher; tier: 'verified' | 'community' };

/**
 * Ecosystem console → Publisher verification (`publishers:verify`):
 * pending Verified applications (decided through the queue's review view), and
 * every publisher with its tier and suspension state. Suspending and demoting
 * to Community apply at once; lifting a suspension and awarding Verified are
 * two-person requests. Every write is step-up gated.
 */
export function PublisherVerificationPanel({ can }: Props) {
  const toast = useToast();
  const mayVerify = can('publishers:verify');
  const [tier, setTier] = useState('');
  const [suspended, setSuspended] = useState<'' | 'true' | 'false'>('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q, 300);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);

  const applicationsQ = useFetch(async (signal) => {
    const res = await api.listEcosystemRequests({ status: 'open', kind: 'verify' }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load applications');
    return res.data.requests;
  }, []);
  const publishersQ = useFetch(async (signal) => {
    const res = await api.listEcosystemPublishers({
      ...(tier ? { tier } : {}),
      ...(suspended ? { suspended: suspended === 'true' } : {}),
      ...(debouncedQ.trim() ? { q: debouncedQ.trim() } : {}),
    }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load publishers');
    return res.data.publishers;
  }, [tier, suspended, debouncedQ]);

  const refresh = () => { void applicationsQ.refetch(); void publishersQ.refetch(); };

  if (reviewing) {
    return (
      <SectionCard icon={BadgeCheck} title="Publisher verification">
        <QueueItemDetail id={reviewing} can={can} backLabel="Back to publishers" onBack={() => setReviewing(null)} onDecided={refresh} />
      </SectionCard>
    );
  }

  const applications = applicationsQ.data ?? [];
  const publishers = publishersQ.data ?? [];

  const run = async (reason: string, token?: string) => {
    if (!action) return;
    const p = action.publisher;
    if (action.kind === 'suspend') {
      await api.suspendPublisher(p.id, reason, token);
      toast.success(`Suspended ${p.handle}`);
    } else if (action.kind === 'unsuspend') {
      await api.unsuspendPublisher(p.id, reason || undefined, token);
      toast.success(`Lifting the suspension of ${p.handle} now waits for a second approver`);
    } else {
      const res = await api.setPublisherTier(p.id, action.tier, reason, token);
      toast.success(res.data?.request
        ? `Verified status for ${p.handle} now waits for a second approver`
        : `${p.handle} is now ${action.tier === 'community' ? 'Community' : 'Verified'}`);
    }
    refresh();
  };

  return (
    <div className="space-y-6">
      <SectionCard icon={BadgeCheck} title="Verified applications" description="Publishers applying for the Verified badge. Plan, verified domain and owner MFA are checked automatically when they apply and again when you decide; review the rest before deciding.">
        {applicationsQ.loading && !applicationsQ.data ? (
          <Skeleton className="h-16 w-full" />
        ) : applicationsQ.error ? (
          <RetryError message={formatError(applicationsQ.error, 'Failed to load applications')} onRetry={applicationsQ.refetch} />
        ) : applications.length === 0 ? (
          <EmptyState compact icon={BadgeCheck} title="No pending applications" />
        ) : (
          <ul className="divide-y divide-default" aria-label="Verified applications">
            {applications.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="text-sm">
                  <span className="font-mono font-medium text-fg">{r.publisherHandle}</span>
                  {r.payload.application?.domain && <span className="text-fg-muted"> · {r.payload.application.domain}</span>}
                  <span className="block text-xs text-fg-muted">Applied <RelativeTime value={r.submittedAt} /></span>
                  {r.payload.eligibility && (
                    <span className="mt-1 block"><VerifiedEligibilityChecks eligibility={r.payload.eligibility} compact /></span>
                  )}
                </div>
                <Button variant="secondary" size="xs" onClick={() => setReviewing(r.id)} aria-label={`Review application from ${r.publisherHandle}`}>
                  Review
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard icon={Users} title="Publishers" description="Every publisher, its tier and whether it is suspended.">
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="Search" className="min-w-[14rem]">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Handle or name" />
            </FormField>
            <FormField label="Tier" className="min-w-[10rem]">
              <Select value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">All tiers</option>
                <option value="official">Official</option>
                <option value="verified">Verified</option>
                <option value="community">Community</option>
                <option value="unverified">Unverified</option>
              </Select>
            </FormField>
            <FormField label="Suspension" className="min-w-[10rem]">
              <Select value={suspended} onChange={(e) => setSuspended(e.target.value as '' | 'true' | 'false')}>
                <option value="">All</option>
                <option value="true">Suspended</option>
                <option value="false">Active</option>
              </Select>
            </FormField>
          </div>

          {publishersQ.loading && !publishersQ.data ? (
            <Skeleton className="h-24 w-full" />
          ) : publishersQ.error ? (
            <RetryError message={formatError(publishersQ.error, 'Failed to load publishers')} onRetry={publishersQ.refetch} />
          ) : publishers.length === 0 ? (
            <EmptyState compact icon={Users} title="No publishers match" />
          ) : (
            <ul className="divide-y divide-default" aria-label="Publishers">
              {publishers.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2" data-testid={`publisher-${p.handle}`}>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-fg">{p.displayName}</span>
                      <span className="font-mono text-fg-muted">@{p.handle}</span>
                      <TrustTierBadge tier={p.tier} />
                      {p.suspendedAt && <Badge color="red">Suspended</Badge>}
                      {p.verifiedGraceUntil && <Badge color="yellow">Verified grace until {new Date(p.verifiedGraceUntil).toLocaleDateString()}</Badge>}
                    </div>
                    <p className="text-xs text-fg-muted">
                      {p.listingCount} listing{p.listingCount === 1 ? '' : 's'}
                      {p.suspendReason && <> · {p.suspendReason}</>}
                    </p>
                  </div>
                  {mayVerify && p.tier !== 'official' && (
                    <div className="flex flex-wrap gap-1">
                      {p.tier !== 'verified' && (
                        <Button variant="secondary" size="xs" onClick={() => setAction({ kind: 'tier', publisher: p, tier: 'verified' })} aria-label={`Make ${p.handle} Verified`}>
                          <BadgeCheck className="w-3.5 h-3.5 mr-1" aria-hidden />Make Verified
                        </Button>
                      )}
                      {p.tier === 'verified' && (
                        <Button variant="secondary" size="xs" onClick={() => setAction({ kind: 'tier', publisher: p, tier: 'community' })} aria-label={`Set ${p.handle} to Community`}>
                          Set to Community
                        </Button>
                      )}
                      {p.suspendedAt ? (
                        <Button variant="secondary" size="xs" onClick={() => setAction({ kind: 'unsuspend', publisher: p })} aria-label={`Lift the suspension of ${p.handle}`}>
                          <RotateCcw className="w-3.5 h-3.5 mr-1" aria-hidden />Unsuspend
                        </Button>
                      ) : (
                        <Button variant="danger-outline" size="xs" onClick={() => setAction({ kind: 'suspend', publisher: p })} aria-label={`Suspend ${p.handle}`}>
                          <Ban className="w-3.5 h-3.5 mr-1" aria-hidden />Suspend
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionCard>

      {action?.kind === 'suspend' && (
        <EcosystemActionDialog
          title={`Suspend ${action.publisher.handle}?`}
          action={`Suspend publisher ${action.publisher.handle}`}
          details={<p>The publisher&apos;s new requests are refused at once. Lifting a suspension takes two approvers.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'unsuspend' && (
        <EcosystemActionDialog
          title={`Lift the suspension of ${action.publisher.handle}?`}
          action={`Request lifting the suspension of ${action.publisher.handle}`}
          details={<p>Two-person action: this creates a request that a second Ecosystem Manager or a superadmin must approve.</p>}
          reasonLabel="Reason (optional)"
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'tier' && (
        <EcosystemActionDialog
          title={action.tier === 'verified' ? `Make ${action.publisher.handle} Verified?` : `Set ${action.publisher.handle} to Community?`}
          action={action.tier === 'verified' ? `Request Verified status for ${action.publisher.handle}` : `Remove Verified status from ${action.publisher.handle}`}
          details={action.tier === 'verified'
            ? <p>Two-person action: a second approver must confirm before the badge appears.</p>
            : <p>The Verified badge is removed from every listing at once.</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}
