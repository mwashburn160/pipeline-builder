// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { responseTargetLabel } from '@/components/message/MessageList';
import { SupportCaseNotes } from '@/components/message/SupportCaseNotes';
import type { SupportQueueRow } from '@/types';

/** Severities staff may re-rank a case to. */
const SEVERITIES = ['normal', 'high', 'urgent'] as const;

/**
 * Wait, in the units a human triages by.
 *
 * This is RESPONSE age — the server already subtracted time spent awaiting the
 * customer — so it is how long the case has been on US. Showing raw elapsed
 * time would make every case the customer sat on look like our backlog.
 */
function waitLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * The support queue: every open case across all tenants, longest-waiting first.
 *
 * `systemAdminOnly` in `nav.ts`, which is also this page's read gate —
 * `page-access.ts` derives the route requirement from that declaration and
 * `useAuthGuard()` applies it, so the gate is stated once.
 */
export default function SupportQueuePage() {
  const { isReady, accessDenied } = useAuthGuard();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  /** Threads ticked for a bulk action. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queue = useFetch(async () => {
    const res = await api.getSupportQueue();
    return res.data?.cases ?? [];
  }, []);

  const act = async (threadId: string, fn: () => Promise<unknown>) => {
    setBusy(threadId);
    try {
      await fn();
      await queue.refetch();
    } finally {
      setBusy(null);
    }
  };

  const toggleOne = (threadId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(threadId)) next.delete(threadId);
    else next.add(threadId);
    return next;
  });

  /**
   * Run a bulk action over the ticked threads.
   *
   * Reports MOVED against REQUESTED rather than just succeeding. On a shared
   * queue a stale selection is the normal case — somebody else took or closed a
   * case between the render and the click — and a bare "done" would hide it.
   */
  const bulk = async (action: 'assign' | 'close', assignedTo?: string | null) => {
    const threadIds = [...selected];
    if (threadIds.length === 0) return;
    setBusy('bulk');
    try {
      const res = await api.bulkSupportCases(threadIds, action, assignedTo);
      const moved = res.data?.moved.length ?? 0;
      if (moved < threadIds.length) {
        toast.warning(`${moved} of ${threadIds.length} updated — the rest had already changed.`);
      } else {
        toast.success(`${moved} case(s) updated`);
      }
      setSelected(new Set());
      await queue.refetch();
    } finally {
      setBusy(null);
    }
  };

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady) return <LoadingPage />;

  const rows: SupportQueueRow[] = queue.data ?? [];

  return (
    <DashboardLayout title="Support queue">
      <div className="space-y-4">
        {queue.error && <RetryError message="The support queue could not be loaded" onRetry={queue.refetch} />}

        {!queue.error && rows.length === 0 && (
          <EmptyState
            title="Nothing waiting"
            description="No support case is currently open. Cases appear here as soon as a tenant raises one."
          />
        )}

        {/* The bulk bar, shown only with a selection. Above the list so the
            count and the actions stay put while scrolling a long queue. */}
        {selected.size > 0 && (
          <Card>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <Button disabled={busy !== null} onClick={() => bulk('assign', 'me')}>Take all</Button>
              <Button variant="secondary" disabled={busy !== null} onClick={() => bulk('assign', null)}>
                Release all
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={() => bulk('close')}>
                Close all
              </Button>
              <button
                type="button"
                className="ml-auto text-xs text-info underline"
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </button>
            </div>
          </Card>
        )}

        {rows.map((c) => (
          <Card key={c.threadId}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(c.threadId)}
                onChange={() => toggleOne(c.threadId)}
                aria-label={`Select case ${c.displayNumber}`}
              />
              <span className="font-semibold">#{c.displayNumber}</span>
              {/* The tenant, because triage's first question is whose case it is. */}
              <span className="text-fg-muted">{c.orgId}</span>
              {/* The level FROZEN at open, with the target it committed to — not
                  what the org's plan says today. */}
              <span className="text-fg-muted">
                {c.level}
                {responseTargetLabel(c.level) ? ` · ${responseTargetLabel(c.level)}` : ''}
              </span>
              {/* Response age, and whether anyone has answered at all. Those are
                  different facts: a case answered once and waiting again is not
                  the same as one nobody has touched. */}
              <span className={c.firstResponseAt ? 'text-fg-muted' : 'text-danger font-semibold'}>
                {waitLabel(c.waitingSeconds)} {c.firstResponseAt ? 'since last reply' : 'unanswered'}
              </span>

              <label className="flex items-center gap-1 ml-auto">
                <span className="text-xs text-fg-muted">Severity</span>
                <Select
                  aria-label={`Severity for case ${c.displayNumber}`}
                  value={SEVERITIES.includes(c.severity as typeof SEVERITIES[number]) ? c.severity : 'normal'}
                  disabled={busy === c.threadId}
                  onChange={(e) => act(c.threadId, () => api.setSupportCaseSeverity(c.threadId, e.target.value))}
                  className="text-xs"
                >
                  {SEVERITIES.map((sv) => <option key={sv} value={sv}>{sv}</option>)}
                </Select>
              </label>

              {/* Take it, or release it. Release is a first-class action, not an
                  empty selection: "I cannot take this" has to be sayable without
                  inventing a pseudo-assignee, and a case stuck on whoever opened
                  it first is how the unowned pool stops working. */}
              {c.assignedTo ? (
                <Button
                  variant="secondary"
                  disabled={busy === c.threadId}
                  onClick={() => act(c.threadId, () => api.assignSupportCase(c.threadId, null))}
                >
                  Release case
                </Button>
              ) : (
                <Button
                  disabled={busy === c.threadId}
                  onClick={() => act(c.threadId, () => api.assignSupportCase(c.threadId, 'me'))}
                >
                  Take case
                </Button>
              )}
            </div>

            {/* Triage context for whoever picks this up next. Collapsed, and
                loaded on expand — a fifty-case queue would otherwise make
                fifty requests to show nothing. */}
            <SupportCaseNotes threadId={c.threadId} caseNumber={c.displayNumber} />
          </Card>
        ))}
      </div>
    </DashboardLayout>
  );
}
