// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import Link from 'next/link';
import { Inbox as InboxIcon, AlertTriangle, ShieldCheck, MessageSquare, RefreshCw, CheckCircle2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import type { LucideIcon } from 'lucide-react';

type Severity = 'high' | 'medium' | 'low';

interface InboxItem {
  id: string;
  kind: 'pipeline-failure' | 'exemption' | 'messages';
  title: string;
  detail?: string;
  href: string;
  severity: Severity;
  icon: LucideIcon;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_DOT: Record<Severity, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-blue-500',
};

/** The owned-pipelines join needs ids only — the whole set is drained. */
const OWNED_FIELDS = ['id'] as const;

/** Pending exemptions listed individually; the rest collapse into one
 *  "N more" item that links to the full, paged Exemptions view. */
export const EXEMPTION_PREVIEW = 20;

const COMPLIANCE_EXEMPTIONS_HREF = '/dashboard/compliance?view=exemptions';

/**
 * Unified actionable inbox: a single triage queue that aggregates a developer's
 * action items across domains — failing pipelines they own, compliance
 * exemptions awaiting review (admins), and unread messages. Frontend-only
 * aggregation over existing endpoints; each source is loaded independently so
 * one failing source never blanks the page. Sources that aren't queryable today
 * (invitations to accept, AWS manual-approval steps) are intentionally omitted.
 *
 * Nothing here is capped silently: the owned-pipeline set is cursor-drained
 * (a join against a capped page would miss failures past the cap), and the
 * exemptions source says how many more are pending than it lists.
 */
export default function InboxPage() {
  const { user, isReady, can } = useAuthGuard();

  const canReviewCompliance = can('compliance:write');
  const canReadMessages = can('messages:read');
  const canReadReports = can('reports:read');
  const ownerId = user?.id;
  const active = isReady && !!ownerId;

  // Failing pipelines I own — join owned pipeline ids against execution counts.
  // Gated on reports:read (the execution-count source requires it). Both reads
  // go through the shared cache (the home page and Executions ask for the same).
  const joinEnabled = active && canReadReports;
  const owned = useQuery(joinEnabled ? queries.allPipelines(OWNED_FIELDS, { ownerId: ownerId! }) : null);
  const counts = useQuery(joinEnabled ? queries.executionCount() : null);

  // Compliance exemptions awaiting review (admins only).
  const exemptions = useFetch(async () => {
    if (!active || !canReviewCompliance) return null;
    const res = await api.getExemptions({ status: 'pending', limit: EXEMPTION_PREVIEW, offset: 0 });
    if (!(res.success && res.data)) throw new Error('source unavailable');
    return res.data;
  }, [active, canReviewCompliance]);

  // Unread messages — a single summary item.
  const unread = useFetch(async () => {
    if (!active || !canReadMessages) return null;
    const res = await api.getUnreadCount();
    if (!(res.success && res.data)) throw new Error('source unavailable');
    return res.data.count ?? 0;
  }, [active, canReadMessages]);

  // Per-source outcome: items when it loaded, `null` when it failed, and
  // `undefined` when it wasn't attempted (no permission) or is still loading.
  const pipelineItems = useMemo((): InboxItem[] | null | undefined => {
    if (!joinEnabled) return undefined;
    if (owned.error || counts.error || (counts.data && !counts.data.success)) return null;
    if (!owned.data || !counts.data?.data) return undefined;
    const ownedIds = new Set(owned.data.map((p) => p.id));
    return counts.data.data.pipelines
      .filter((row) => ownedIds.has(row.id) && row.failed > 0)
      .map((row): InboxItem => ({
        id: `pipeline:${row.id}`,
        kind: 'pipeline-failure',
        title: `${row.pipeline_name || row.project} has ${row.failed} failed run${row.failed === 1 ? '' : 's'}`,
        detail: `${row.succeeded} succeeded · ${row.total} total`,
        href: `/dashboard/pipelines/${row.id}`,
        severity: 'high',
        icon: AlertTriangle,
      }));
  }, [joinEnabled, owned.data, owned.error, counts.data, counts.error]);

  const exemptionItems = useMemo((): InboxItem[] | null | undefined => {
    if (!canReviewCompliance) return undefined;
    if (exemptions.error) return null;
    if (!exemptions.data) return undefined;
    const listed = exemptions.data.exemptions.map((ex): InboxItem => ({
      id: `exemption:${ex.id}`,
      kind: 'exemption',
      title: `Exemption request pending review (${ex.entityType})`,
      detail: ex.reason,
      href: COMPLIANCE_EXEMPTIONS_HREF,
      severity: 'medium',
      icon: ShieldCheck,
    }));
    const more = (exemptions.data.pagination?.total ?? listed.length) - listed.length;
    return more > 0
      ? [...listed, {
        id: 'exemption:more',
        kind: 'exemption',
        title: `${more} more exemption request${more === 1 ? '' : 's'} pending review`,
        detail: 'Review them all on the Compliance → Exemptions tab.',
        href: COMPLIANCE_EXEMPTIONS_HREF,
        severity: 'medium',
        icon: ShieldCheck,
      }]
      : listed;
  }, [canReviewCompliance, exemptions.data, exemptions.error]);

  const messageItems = useMemo((): InboxItem[] | null | undefined => {
    if (!canReadMessages) return undefined;
    if (unread.error) return null;
    if (unread.data == null) return undefined;
    return unread.data > 0
      ? [{
        id: 'messages:unread',
        kind: 'messages',
        title: `${unread.data} unread message${unread.data === 1 ? '' : 's'}`,
        href: '/dashboard/messages',
        severity: 'low',
        icon: MessageSquare,
      }]
      : [];
  }, [canReadMessages, unread.data, unread.error]);

  const attempted = [
    joinEnabled ? pipelineItems : false,
    canReviewCompliance ? exemptionItems : false,
    canReadMessages ? messageItems : false,
  ].filter((r) => r !== false);
  const loading = owned.loading || counts.loading || exemptions.loading || unread.loading;

  // Source order is preserved before the (stable) severity sort.
  const items = useMemo(() => {
    const collected = [pipelineItems, exemptionItems, messageItems].flatMap((r) => r ?? []);
    return collected.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }, [pipelineItems, exemptionItems, messageItems]);

  // Only surface an error when EVERY attempted source failed — a partial
  // failure still shows whatever loaded, and a total failure must not read as
  // "Inbox zero" (indistinguishable from a clean inbox).
  const allFailed = attempted.length > 0 && attempted.every((r) => r === null);

  const refetchOwned = owned.refetch;
  const refetchCounts = counts.refetch;
  const refetchExemptions = exemptions.refetch;
  const refetchUnread = unread.refetch;
  const fetchAll = () => {
    if (joinEnabled) { refetchOwned(); refetchCounts(); }
    refetchExemptions();
    refetchUnread();
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Inbox"
      subtitle="Your action items across pipelines, compliance, and messages"
      actions={
        <IconButton onClick={fetchAll} title="Refresh" aria-label="Refresh" disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </IconButton>
      }
    >
      <div className="page-section">
        {loading && items.length === 0 ? (
          <Card><p className="text-sm text-fg-subtle py-6 text-center">Loading your action items…</p></Card>
        ) : allFailed ? (
          <RetryError message="Could not load your action items. Please retry." onRetry={fetchAll} />
        ) : items.length === 0 ? (
          <Card>
            <EmptyState
              icon={CheckCircle2}
              title="Inbox zero"
              description="No failing pipelines you own, no pending reviews, and no unread messages."
            />
          </Card>
        ) : (
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <InboxIcon className="w-5 h-5 text-fg-muted" />
              <h3 className="text-base font-semibold text-fg">{items.length} action item{items.length === 1 ? '' : 's'}</h3>
            </div>
            <ul className="divide-y divide-default">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link href={item.href} className="flex items-start gap-3 py-3 hover:bg-surface-muted/40 -mx-2 px-2 rounded-lg transition-colors">
                      <span role="img" aria-label={`${item.severity} priority`} className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${SEVERITY_DOT[item.severity]}`} />
                      <Icon className="w-4 h-4 mt-0.5 text-fg-subtle shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-fg">{item.title}</span>
                        {item.detail && <span className="block text-xs text-fg-muted truncate">{item.detail}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
