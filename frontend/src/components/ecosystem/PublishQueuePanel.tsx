// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, Check, CheckCheck, Inbox, ShieldAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { requestSubject } from '@/components/publisher/PublishRequestsPanel';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import {
  ECOSYSTEM_RUNBOOK_URL, MODERATION_ACTION_LABELS, REQUEST_KIND_LABELS, REQUEST_STATUS_COLORS, REQUEST_STATUS_LABELS,
} from '@/lib/ecosystem';
import type { EcosystemOverview, PublishRequestKind, PublishRequestLane, QueueItem, QueueStatusFilter } from '@/types/ecosystem';
import { EcosystemActionDialog } from './EcosystemActionDialog';
import { ApproverStandingNotice, VerifiedEligibilityChecks } from './EcosystemEligibility';
import { ReviewDiffView } from './ReviewDiffView';
import { ClaimEmailMatchNotice, SubmissionReviewSection } from './SubmissionReviewSection';

interface Props {
  /** `useAuthGuard().can` — false for every ecosystem action during a read-only impersonation. */
  can: (permission: string) => boolean;
}

const STATUS_OPTIONS: ReadonlyArray<{ value: QueueStatusFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'pending_second_approval', label: 'Awaiting second approval' },
  { value: 'auto', label: 'Auto-approved' },
  { value: 'decided', label: 'Decided' },
];

const KINDS = Object.keys(REQUEST_KIND_LABELS) as PublishRequestKind[];

/** What a queue row / detail header calls a request. */
function subjectOf(item: QueueItem): string {
  if (item.kind === 'moderation' && item.payload.action) {
    return `${MODERATION_ACTION_LABELS[item.payload.action] ?? item.payload.action}${item.listingName ? `: ${item.listingName}` : ''}`;
  }
  return requestSubject(item);
}

function formatAge(hours: number): string {
  if (hours < 1) return 'under 1h';
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The queue overview: approver headroom, pending counts, bootstrap and Official auto-approval state. */
function OverviewHeader({ overview }: { overview: EcosystemOverview }) {
  const moderate = overview.approvers.moderate;
  const managers = moderate.count?.holders ?? null;
  const resignPending = overview.resignJobs?.length ?? 0;
  const tiles: Array<{ label: string; value: string | number; tone?: 'warn' | 'danger' }> = [
    { label: 'Ecosystem Managers', value: managers ?? '—', tone: moderate.belowMinimum ? 'warn' : undefined },
    { label: 'Standard lane', value: overview.pending.standard },
    { label: 'Security lane', value: overview.pending.security, tone: overview.pending.security > 0 ? 'danger' : undefined },
    { label: 'Awaiting second approval', value: overview.pending.secondApproval },
    { label: 'Verification', value: overview.pending.verify },
  ];
  return (
    <div className="space-y-3" data-testid="queue-overview">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-default p-3">
            <dt className="text-xs text-fg-muted">{t.label}</dt>
            <dd className={`text-lg font-semibold ${t.tone === 'danger' ? 'text-danger-strong' : t.tone === 'warn' ? 'text-warning-strong' : 'text-fg'}`}>{t.value}</dd>
          </div>
        ))}
      </dl>
      <ApproverStandingNotice standing={moderate} minimum={overview.approvers.minimum} scope="console" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span>
          Bootstrap exception:{' '}
          <span className="font-medium text-fg">
            {overview.bootstrap.state === 'open' ? 'open' : overview.bootstrap.state === 'closed' ? 'closed' : 'never opened'}
          </span>
          {overview.bootstrap.reason && <> ({overview.bootstrap.reason})</>}
          {overview.bootstrap.approved != null && <>, {overview.bootstrap.approved} approved under it</>}
        </span>
        <span>
          Official auto-approval:{' '}
          <span className="font-medium text-fg">{overview.officialAutoApprovalEnabled ? 'enabled' : 'disabled by instance flag'}</span>
        </span>
        {overview.officialLoaderAccount && (
          <span>Catalog loader: <span className="font-mono">{overview.officialLoaderAccount}</span></span>
        )}
        <span>Terms version: <span className="font-mono">{overview.termsVersion}</span></span>
        {resignPending > 0 && <span data-testid="resign-jobs">{resignPending} re-sign job{resignPending === 1 ? '' : 's'} running</span>}
        <a href={ECOSYSTEM_RUNBOOK_URL} target="_blank" rel="noopener noreferrer" className="action-link inline-flex items-center gap-1">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />Moderation runbook
        </a>
      </div>
    </div>
  );
}

type Decision = 'approve' | 'second-approve' | 'reject';

/** One request with its review diff and the decision controls. */
export function QueueItemDetail({ id, can, onBack, onDecided, backLabel = 'Back to the queue' }: {
  id: string;
  can: Props['can'];
  onBack: () => void;
  onDecided: () => void;
  backLabel?: string;
}) {
  const toast = useToast();
  const detailQ = useFetch(async (signal) => {
    const res = await api.getEcosystemRequest(id, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the request');
    return res.data;
  }, [id]);
  const [decision, setDecision] = useState<Decision | null>(null);

  const back = (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft className="w-4 h-4 mr-1" aria-hidden />{backLabel}
    </Button>
  );

  if (detailQ.loading && !detailQ.data) return <div className="space-y-3">{back}<Skeleton className="h-40 w-full" /></div>;
  if (detailQ.error || !detailQ.data) {
    return <div className="space-y-3">{back}<RetryError message={formatError(detailQ.error, 'Failed to load the request')} onRetry={detailQ.refetch} /></div>;
  }
  const { request: item, review, approvers, eligibility, submission, claimEmailMatch } = detailQ.data;
  const mayDecide = can(item.requiredPermission);
  const isSubmission = item.kind === 'submission';
  // A claim whose email doesn't match the community submitter needs a written justification.
  const needsJustification = item.kind === 'claim' && claimEmailMatch === false;
  const open = item.status === 'pending' || item.status === 'pending_second_approval';
  const blocked = item.conflictOfInterest;
  const blockedTitle = blocked ? item.conflictReason ?? 'You may not decide this request.' : undefined;

  const decide = async (kind: Decision, text: string, token?: string) => {
    if (kind === 'reject') {
      await api.rejectEcosystemRequest(item.id, text);
      toast.success('Request rejected');
    } else if (kind === 'approve') {
      const res = await api.approveEcosystemRequest(item.id, text || undefined, token);
      toast.success(res.data?.request?.status === 'pending_second_approval'
        ? 'Approved. It now waits for a second approver.'
        : 'Request approved');
    } else {
      await api.secondApproveEcosystemRequest(item.id, text || undefined, token);
      toast.success('Second approval recorded; the request was executed');
    }
    void detailQ.refetch();
    onDecided();
  };

  return (
    <div className="space-y-4" data-testid="queue-detail">
      {back}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-fg">{REQUEST_KIND_LABELS[item.kind]}</h3>
          <span className="font-mono text-sm text-fg-muted">{subjectOf(item)}</span>
          <Badge color={REQUEST_STATUS_COLORS[item.status]}>{REQUEST_STATUS_LABELS[item.status]}</Badge>
          {item.lane === 'security' && <Badge color="red">Security lane</Badge>}
          {item.payload.bootstrap && <Badge color="blue">Bootstrap</Badge>}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <TrustTierBadge tier={item.publisherTier} compact /> {item.publisherHandle}
          <span>· submitted <RelativeTime value={item.submittedAt} /></span>
          {item.payload.submitter?.principalType === 'service_account' && <span>· by service account {item.payload.submitter.name ?? ''}</span>}
          <span className={item.slaBreached ? 'font-medium text-danger-strong' : ''}>
            · age {formatAge(item.ageHours)} of {item.slaHours}h SLA{item.slaBreached ? ' (breached)' : ''}
          </span>
        </p>
        {item.reason && <p className="text-xs text-fg">Reason: {item.reason}</p>}
      </div>

      {open && mayDecide && (
        <div className="space-y-2 rounded-lg border border-default p-3" data-testid="queue-decision">
          {blocked && (
            <Callout variant="warning" icon={ShieldAlert} title="You can't decide this request">
              {item.conflictReason ?? 'Separation of duties: another Ecosystem Manager must decide it.'}
            </Callout>
          )}
          <ApproverStandingNotice standing={approvers} scope="request" requiresTwoPerson={item.requiresTwoPerson} />
          {item.requiresTwoPerson && (
            <p className="text-xs text-fg-muted" data-testid="two-person-note">
              {item.status === 'pending'
                ? 'Two-person approval: your approval moves it to "Awaiting second approval"; a different Ecosystem Manager or a superadmin must confirm before it takes effect.'
                : `First approved${item.firstApprovedBy ? ` by ${item.firstApprovedBy}` : ''}. A second, different approver completes it.`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {item.status === 'pending' ? (
              <Button size="sm" onClick={() => setDecision('approve')} disabled={blocked} title={blockedTitle}>
                <Check className="w-4 h-4 mr-1" aria-hidden />Approve
              </Button>
            ) : (
              <Button size="sm" onClick={() => setDecision('second-approve')} disabled={blocked} title={blockedTitle}>
                <CheckCheck className="w-4 h-4 mr-1" aria-hidden />Second-approve
              </Button>
            )}
            <Button size="sm" variant="danger-outline" onClick={() => setDecision('reject')} disabled={blocked} title={blockedTitle}>
              <X className="w-4 h-4 mr-1" aria-hidden />Reject
            </Button>
          </div>
        </div>
      )}

      {eligibility && <VerifiedEligibilityChecks eligibility={eligibility} title="Verified eligibility (checked now)" />}
      {!eligibility && item.kind === 'verify' && item.payload.eligibility && (
        <VerifiedEligibilityChecks eligibility={item.payload.eligibility} title="Verified eligibility (when submitted)" />
      )}

      {item.kind === 'claim' && <ClaimEmailMatchNotice match={claimEmailMatch} />}
      {isSubmission && <SubmissionReviewSection submission={submission} />}

      <ReviewDiffView review={review} />

      {decision === 'reject' && (
        <EcosystemActionDialog
          title="Reject this request?"
          action={`Reject ${REQUEST_KIND_LABELS[item.kind].toLowerCase()} ${subjectOf(item)}`}
          details={<p>{isSubmission ? 'The submitter is emailed the reason.' : 'The publisher sees the reason.'}</p>}
          reasonLabel="Reason"
          reasonRequired
          stepUp={false}
          tone="danger"
          confirmLabel="Reject"
          onSubmit={(reason) => decide('reject', reason)}
          onClose={() => setDecision(null)}
        />
      )}
      {(decision === 'approve' || decision === 'second-approve') && (
        <EcosystemActionDialog
          title={decision === 'approve' ? 'Approve this request?' : 'Confirm as second approver?'}
          action={`${decision === 'approve' ? 'Approve' : 'Second-approve'} ${REQUEST_KIND_LABELS[item.kind].toLowerCase()} ${subjectOf(item)}`}
          details={(
            <>
              {decision === 'approve' && item.requiresTwoPerson
                ? <p>This is the first of two approvals; nothing changes until a second approver confirms.</p>
                : <p>This takes effect as soon as you confirm.</p>}
              {isSubmission && (
                <p>Once approved, the image is published to <span className="font-mono">public/community/{item.payload.name ?? item.listingName ?? ''}</span> with the Unverified tier and the submitter is emailed.</p>
              )}
            </>
          )}
          reasonLabel={needsJustification ? 'Justification (the email does not match the submitter)' : 'Note (optional)'}
          reasonRequired={needsJustification}
          stepUp={item.requiresStepUp}
          confirmLabel={decision === 'approve' ? 'Approve' : 'Second-approve'}
          onSubmit={(note, token) => decide(decision, note, token)}
          onClose={() => setDecision(null)}
        />
      )}
    </div>
  );
}

/** Queue rows per page. */
const QUEUE_PAGE = 100;
/** The statuses the server lists oldest first (mirrors the console service). */
const OLDEST_FIRST_STATUSES = new Set<QueueStatusFilter>(['open', 'pending', 'pending_second_approval']);

/**
 * Ecosystem console → Publish queue: every publish, version,
 * listing-update, yank, transfer, profile and moderation request awaiting a
 * system-org decision, with the review diff per request. Decisions
 * respect separation of duties (`conflictOfInterest`), two-person approval and
 * step-up exactly as the server reports them per item.
 */
export function PublishQueuePanel({ can }: Props) {
  const [status, setStatus] = useState<QueueStatusFilter>('open');
  const [kind, setKind] = useState<PublishRequestKind | ''>('');
  const [lane, setLane] = useState<PublishRequestLane | ''>('');
  const [selected, setSelected] = useState<string | null>(null);

  const overviewQ = useFetch(async (signal) => {
    const res = await api.getEcosystemOverview({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the overview');
    return res.data;
  }, []);
  const filters = { status, ...(kind ? { kind } : {}), ...(lane ? { lane } : {}), limit: QUEUE_PAGE };
  const queueQ = useFetch(async (signal) => {
    const res = await api.listEcosystemRequests(filters, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the queue');
    return res.data;
  }, [status, kind, lane]);
  // Pages after the first, appended by "Load more" — without them a busy queue
  // would hide its oldest requests, the ones nearest their SLA.
  const [more, setMore] = useState<{ items: QueueItem[]; nextCursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  useEffect(() => { setMore(null); setMoreError(null); }, [queueQ.data]);

  const refreshAll = () => { void overviewQ.refetch(); void queueQ.refetch(); };
  const items = [...(queueQ.data?.requests ?? []), ...(more?.items ?? [])];
  const total = queueQ.data?.total ?? items.length;
  const nextCursor = more ? more.nextCursor : queueQ.data?.nextCursor ?? null;

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api.listEcosystemRequests({ ...filters, cursor: nextCursor });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to load more of the queue');
      const page = res.data;
      setMore((m) => ({ items: [...(m?.items ?? []), ...page.requests], nextCursor: page.nextCursor }));
    } catch (err) {
      setMoreError(formatError(err, 'Failed to load more of the queue'));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <SectionCard icon={Inbox} title="Publish queue" description="Requests from publishers awaiting a system-org decision.">
      <div className="space-y-5">
        {overviewQ.error
          ? <RetryError message={formatError(overviewQ.error, 'Failed to load the overview')} onRetry={overviewQ.refetch} />
          : overviewQ.data ? <OverviewHeader overview={overviewQ.data} /> : <Skeleton className="h-20 w-full" />}

        {selected ? (
          <QueueItemDetail id={selected} can={can} onBack={() => setSelected(null)} onDecided={refreshAll} />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <FormField label="Status" className="min-w-[12rem]">
                <Select value={status} onChange={(e) => setStatus(e.target.value as QueueStatusFilter)}>
                  {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </FormField>
              <FormField label="Kind" className="min-w-[12rem]">
                <Select value={kind} onChange={(e) => setKind(e.target.value as PublishRequestKind | '')}>
                  <option value="">All kinds</option>
                  {KINDS.map((k) => <option key={k} value={k}>{REQUEST_KIND_LABELS[k]}</option>)}
                </Select>
              </FormField>
              <FormField label="Lane" className="min-w-[10rem]">
                <Select value={lane} onChange={(e) => setLane(e.target.value as PublishRequestLane | '')}>
                  <option value="">Both lanes</option>
                  <option value="security">Security</option>
                  <option value="standard">Standard</option>
                </Select>
              </FormField>
            </div>

            {queueQ.loading && !queueQ.data ? (
              <Skeleton className="h-32 w-full" />
            ) : queueQ.error ? (
              <RetryError message={formatError(queueQ.error, 'Failed to load the queue')} onRetry={queueQ.refetch} />
            ) : items.length === 0 ? (
              <EmptyState compact icon={Inbox} title="Nothing here" description="No requests match these filters." />
            ) : (
              <ul className="divide-y divide-default" aria-label="Queued requests">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className={`flex flex-wrap items-center justify-between gap-3 py-2 ${item.lane === 'security' ? 'border-l-4 border-danger-border pl-2' : ''}`}
                    data-testid={`queue-item-${item.id}`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium text-fg">{REQUEST_KIND_LABELS[item.kind]}</span>
                        <span className="font-mono text-fg-muted">{subjectOf(item)}</span>
                        <Badge color={REQUEST_STATUS_COLORS[item.status]}>{REQUEST_STATUS_LABELS[item.status]}</Badge>
                        {item.lane === 'security' && <Badge color="red">Security lane · {item.slaHours}h SLA</Badge>}
                        {item.slaBreached && <Badge color="red">SLA breached</Badge>}
                        {item.requiresTwoPerson && <Badge color="indigo">Two-person</Badge>}
                        {item.autoRuleId && <Badge color="blue">Auto-approved</Badge>}
                        {item.conflictOfInterest && <Badge color="gray">Not yours to decide</Badge>}
                        {item.kind === 'submission' && (
                          <Badge color="purple">{item.payload.newListing === false ? 'Anonymous · update' : 'Anonymous · new'}</Badge>
                        )}
                      </div>
                      <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                        <TrustTierBadge tier={item.publisherTier} compact /> {item.publisherHandle}
                        <span>· {formatAge(item.ageHours)} old</span>
                      </p>
                    </div>
                    <Button variant="secondary" size="xs" onClick={() => setSelected(item.id)} aria-label={`Review ${REQUEST_KIND_LABELS[item.kind]} ${subjectOf(item)}`}>
                      Review
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {items.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
                <span data-testid="queue-count">
                  Showing {items.length} of {total}
                  {OLDEST_FIRST_STATUSES.has(status) ? ' — oldest first' : ' — newest first'}
                </span>
                {nextCursor && (
                  <Button variant="secondary" size="xs" onClick={() => void loadMore()} loading={loadingMore}>Load more</Button>
                )}
              </div>
            )}
            {moreError && <RetryError message={moreError} onRetry={() => void loadMore()} />}
          </>
        )}
      </div>
    </SectionCard>
  );
}
