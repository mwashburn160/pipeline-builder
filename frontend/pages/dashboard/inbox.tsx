// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Inbox as InboxIcon, AlertTriangle, ShieldCheck, MessageSquare, RefreshCw, CheckCircle2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { formatError } from '@/lib/constants';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import api from '@/lib/api';
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

/**
 * Unified actionable inbox: a single triage queue that aggregates a developer's
 * action items across domains — failing pipelines they own, compliance
 * exemptions awaiting review (admins), and unread messages. Frontend-only
 * aggregation over existing endpoints; each source is loaded independently so
 * one failing source never blanks the page. Sources that aren't queryable today
 * (invitations to accept, AWS manual-approval steps) are intentionally omitted.
 */
export default function InboxPage() {
  const { user, isReady, can } = useAuthGuard();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canReviewCompliance = can('compliance:write');
  const canReadMessages = can('messages:read');
  const canReadReports = can('reports:read');
  const ownerId = user?.id;
  // Generation guard: overlapping runs (permissions resolving + the refresh
  // button) must not let an earlier response clobber a newer one.
  const genRef = useRef(0);

  const fetchAll = useCallback(async () => {
    if (!ownerId) return;
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    const collected: InboxItem[] = [];
    // Track sources so a TOTAL failure renders an error/retry state rather than a
    // misleading "Inbox zero" (which is indistinguishable from a clean inbox).
    let attempted = 0;
    let failed = 0;

    // Failing pipelines I own — join owned pipelines against execution counts.
    // Gated on reports:read (the execution-count source requires it).
    if (canReadReports) {
      attempted++;
      try {
        const [ownedRes, countsRes] = await Promise.all([
          api.listPipelines({ ownerId, limit: '200', includeTotal: 'false' }),
          api.getExecutionCount(),
        ]);
        if (ownedRes.success && ownedRes.data && countsRes.success && countsRes.data) {
          const ownedIds = new Set(ownedRes.data.pipelines.map((p) => p.id));
          for (const row of countsRes.data.pipelines) {
            if (ownedIds.has(row.id) && row.failed > 0) {
              collected.push({
                id: `pipeline:${row.id}`,
                kind: 'pipeline-failure',
                title: `${row.pipeline_name || row.project} has ${row.failed} failed run${row.failed === 1 ? '' : 's'}`,
                detail: `${row.succeeded} succeeded · ${row.total} total`,
                href: `/dashboard/pipelines/${row.id}`,
                severity: 'high',
                icon: AlertTriangle,
              });
            }
          }
        } else {
          failed++;
        }
      } catch { failed++; }
    }

    // Compliance exemptions awaiting review (admins only).
    if (canReviewCompliance) {
      attempted++;
      try {
        const res = await api.getExemptions({ status: 'pending', limit: 50 });
        if (res.success && res.data) {
          for (const ex of res.data.exemptions) {
            collected.push({
              id: `exemption:${ex.id}`,
              kind: 'exemption',
              title: `Exemption request pending review (${ex.entityType})`,
              detail: ex.reason,
              href: '/dashboard/compliance',
              severity: 'medium',
              icon: ShieldCheck,
            });
          }
        } else {
          failed++;
        }
      } catch { failed++; }
    }

    // Unread messages — a single summary item.
    if (canReadMessages) {
      attempted++;
      try {
        const res = await api.getUnreadCount();
        if (res.success && res.data) {
          const count = (res.data as { count?: number }).count ?? 0;
          if (count > 0) {
            collected.push({
              id: 'messages:unread',
              kind: 'messages',
              title: `${count} unread message${count === 1 ? '' : 's'}`,
              href: '/dashboard/messages',
              severity: 'low',
              icon: MessageSquare,
            });
          }
        } else {
          failed++;
        }
      } catch { failed++; }
    }

    // A newer run superseded this one — discard the stale result.
    if (genRef.current !== gen) return;

    collected.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    setItems(collected);
    // Only surface an error when EVERY attempted source failed — a partial
    // failure still shows whatever loaded.
    if (attempted > 0 && failed >= attempted) {
      setError('Could not load your action items. Please retry.');
    }
    setLoading(false);
  }, [ownerId, canReviewCompliance, canReadMessages, canReadReports]);

  useEffect(() => {
    if (isReady) fetchAll().catch((err) => setError(formatError(err, 'Failed to load inbox')));
  }, [isReady, fetchAll]);

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
          <Card><p className="text-sm text-gray-400 py-6 text-center">Loading your action items…</p></Card>
        ) : error && items.length === 0 ? (
          <Card className="flex flex-col items-center text-center py-14">
            <div className="w-16 h-16 rounded-2xl bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
              <AlertTriangle className="w-9 h-9 text-red-500" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-gray-900 dark:text-gray-100">Couldn&apos;t load your inbox</h3>
            <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 max-w-sm">{error}</p>
            <button onClick={fetchAll} className="mt-4 action-link text-sm">Retry</button>
          </Card>
        ) : items.length === 0 ? (
          <Card className="flex flex-col items-center text-center py-14">
            <div className="w-16 h-16 rounded-2xl bg-green-50 dark:bg-green-900/20 flex items-center justify-center">
              <CheckCircle2 className="w-9 h-9 text-green-500" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-gray-900 dark:text-gray-100">Inbox zero</h3>
            <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 max-w-sm">
              No failing pipelines you own, no pending reviews, and no unread messages.
            </p>
          </Card>
        ) : (
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <InboxIcon className="w-5 h-5 text-gray-500" />
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{items.length} action item{items.length === 1 ? '' : 's'}</h3>
            </div>
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link href={item.href} className="flex items-start gap-3 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/40 -mx-2 px-2 rounded-lg transition-colors">
                      <span role="img" aria-label={`${item.severity} priority`} className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${SEVERITY_DOT[item.severity]}`} />
                      <Icon className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{item.title}</span>
                        {item.detail && <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">{item.detail}</span>}
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
