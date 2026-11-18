// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CheckCircle2, AlertTriangle, Circle, HelpCircle, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { hasPermission } from '@/lib/auth-helpers';
import { classifyIngestHealth } from '@/components/reports/IngestFreshness';
import { RelativeTime } from '@/components/ui/RelativeTime';
import {
  INGEST_ACCOUNT_NAME,
  PLATFORM_ACCOUNT_NAME,
  REGISTRATION_ACCOUNT_NAME,
  REGISTRY_ACCOUNT_NAME,
  keyStatus,
  type SetupItemState,
  type SetupItemStatus,
} from '@/lib/setup-guide';
import type { User } from '@/types';

const ICON: Record<SetupItemState, { icon: typeof Circle; className: string; label: string }> = {
  done: { icon: CheckCircle2, className: 'text-success', label: 'Done' },
  missing: { icon: Circle, className: 'text-fg-subtle', label: 'Not done' },
  attention: { icon: AlertTriangle, className: 'text-warning', label: 'Needs attention' },
  unknown: { icon: HelpCircle, className: 'text-fg-subtle', label: 'Unknown' },
};

/** `extra` replaces the detail line when given (a live relative time). */
function Row({ label, status, extra }: { label: string; status: SetupItemStatus; extra?: React.ReactNode }) {
  const { icon: Icon, className, label: stateLabel } = ICON[status.state];
  const line = extra ?? status.detail;
  return (
    <li className="flex items-start gap-2" data-state={status.state}>
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${className}`} aria-label={stateLabel} />
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {line && <div className="text-xs text-fg-muted">{line}</div>}
      </div>
    </li>
  );
}

/**
 * What the platform can SEE of the setup guide having been followed, read live:
 * the two keys `store-token` issues, and whether the event forwarder has reported
 * in. "Done" on the popup proves nothing; this does — in particular a forwarder
 * holding the wrong credential shows here as "no events", not as finished.
 *
 * Each read is gated on the permission its endpoint enforces, and a row the
 * viewer cannot read says so rather than claiming the step is undone.
 */
export function SetupStatusPanel({ orgId, user, showEvents }: { orgId: string; user: User | null; showEvents: boolean }) {
  const canAccounts = hasPermission(user, 'service_accounts:manage');
  const canReports = hasPermission(user, 'reports:read');

  const accounts = useFetch(
    async (signal) => (await api.listServiceAccounts(orgId, { signal })).data?.serviceAccounts ?? [],
    [orgId],
    { enabled: canAccounts && showEvents },
  );
  const health = useFetch(
    async (signal) => (await api.getIngestHealth({ signal })) ?? null,
    [orgId],
    { enabled: canReports && showEvents },
  );

  if (!showEvents) return null;

  const accountList = canAccounts && !accounts.error ? accounts.data : null;
  const loadingAccounts = canAccounts && accounts.loading && !accounts.data;
  const key = (name: string): SetupItemStatus => (loadingAccounts ? { state: 'unknown', detail: 'Checking…' } : keyStatus(accountList, name));

  let events: SetupItemStatus;
  let since: string | null = null;
  if (!canReports || health.error) {
    events = { state: 'unknown', detail: canReports ? 'Could not read ingestion health.' : 'You can’t view reports in this organization.' };
  } else if (health.loading && !health.data) {
    events = { state: 'unknown', detail: 'Checking…' };
  } else {
    const s = classifyIngestHealth(health.data);
    since = s.since;
    events = s.state === 'flowing'
      ? { state: 'done', detail: null }
      : s.state === 'never'
        ? { state: 'missing', detail: 'No events received yet. They start arriving after the first pipeline run.' }
        : s.state === 'dropping'
          ? { state: 'attention', detail: `The forwarder reports ${s.dropped} dropped events.` }
          : { state: 'attention', detail: null };
  }

  const refresh = () => { void accounts.refetch(); void health.refetch(); };

  return (
    <section aria-label="Setup progress" className="rounded-lg border border-default p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold">Progress</div>
        <button type="button" onClick={refresh} className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
          <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Refresh
        </button>
      </div>
      <ul className="space-y-2">
        <Row label="Platform token stored" status={key(PLATFORM_ACCOUNT_NAME)} />
        <Row label="Registry token stored" status={key(REGISTRY_ACCOUNT_NAME)} />
        <Row label="Pipeline-registration token stored" status={key(REGISTRATION_ACCOUNT_NAME)} />
        <Row label="Reporting-ingest token stored" status={key(INGEST_ACCOUNT_NAME)} />
        <Row
          label="Pipeline events received"
          status={events}
          extra={since && events.state === 'done'
            ? <>Last event <RelativeTime value={since} />.</>
            : since && events.state === 'attention' && !events.detail
              ? <>Nothing since <RelativeTime value={since} /> — check the ingestion stack, or it may just be a quiet day.</>
              : undefined}
        />
      </ul>
    </section>
  );
}
