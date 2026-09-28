// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, FileText, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import { useUrlTab } from '@/hooks/useUrlTab';
import api from '@/lib/api';
import type {
  ReportDefinition,
  ReportPolicy,
  ReportRecipient,
  ReportRun,
} from '@/lib/api/domains/stakeholder-reports';
import type { TabDataStatus } from '../useReportData';
import { ReportDefinitionForm } from '../stakeholder/ReportDefinitionForm';
import { ReportPreview } from '../stakeholder/ReportPreview';
import { ReportPolicyCard } from '../stakeholder/ReportPolicyCard';
import { ReportRecipients } from '../stakeholder/ReportRecipients';
import { ReportReview } from '../stakeholder/ReportReview';

/** Why a definition stopped, and what the lead does about it. */
const PAUSE_REASONS: Record<string, string> = {
  entitlement: 'Stakeholder Reports is no longer on this organization’s plan. Restore the add-on to resume it.',
  owner_inactive: 'Its owner no longer has access to this organization. Transfer it to someone who does, then resume it.',
  permission_lost: 'Its owner no longer has permission to author reports. Transfer it, or restore their permission.',
};

type InnerTab = 'reports' | 'recipients' | 'settings';

const INNER_TABS = [
  { id: 'reports' as const, label: 'Reports' },
  { id: 'recipients' as const, label: 'Recipients' },
  { id: 'settings' as const, label: 'Settings' },
];
const INNER_TAB_IDS: readonly InnerTab[] = INNER_TABS.map((t) => t.id);

interface StakeholderTabProps {
  /** Whether `stakeholder_reports` is entitled — non-entitled renders the lock. */
  enabled: boolean;
  /** `reports:author` — create, edit, schedule, annotate. */
  canAuthor: boolean;
  /** `reports:share` — publish and mint public links. */
  canShare: boolean;
  /** `reports:rollup` — a definition may cover descendant teams. */
  canRollup: boolean;
  /** `org:settings` — may change the org's recipient/sharing policy. */
  canAdmin: boolean;
  /** Read-only impersonation: writes render disabled with the reason. */
  readOnly?: boolean;
  onStatus: (status: TabDataStatus) => void;
}

/**
 * Stakeholder reports: saved, scheduled, manager-facing summaries.
 *
 * Distinct from every other tab on this page, which answers "how are we doing
 * right now" for the team itself. This one produces something that LEAVES the
 * platform — a frozen snapshot with the lead's own words on it, delivered to
 * people who mostly have no account here. That is why it is an entitlement, why
 * publishing is a separate permission from authoring, and why the review step
 * exists at all.
 *
 * Non-entitled orgs get the lock rather than a hidden tab: hiding it would leave
 * a customer unable to find out the product can do this.
 */
export function StakeholderTab({
  enabled, canAuthor, canShare, canRollup, canAdmin, readOnly = false, onStatus,
}: StakeholderTabProps) {
  // `?panel=` so a panel is linkable: "the recipients list" and "who reports may
  // reach" are both things one person sends another, and a tab that only exists in
  // component state cannot be pointed at.
  const [inner, setInner] = useUrlTab<InnerTab>('panel', INNER_TAB_IDS, 'reports');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReportDefinition | null>(null);
  const [creating, setCreating] = useState(false);
  const action = useFormState();

  // One load for the three things every panel needs. Nothing fires while the tab
  // is unentitled — the API would 403 and the lock is the answer already.
  const definitions = useFetch<ReportDefinition[]>(
    async (signal) => {
      const res = await api.listReportDefinitions({ signal });
      if (res.success && res.data) return res.data.definitions;
      throw new Error('Could not load your reports');
    },
    [enabled],
    { enabled },
  );
  const recipients = useFetch<ReportRecipient[]>(
    async (signal) => {
      const res = await api.listReportRecipients({ signal });
      if (res.success && res.data) return res.data.recipients;
      throw new Error('Could not load the recipients');
    },
    [enabled],
    { enabled },
  );
  /**
   * Whether this instance can send email at all.
   *
   * Loaded with everything else so the schedule form can warn BEFORE a lead picks a
   * distribution list. Fails soft to `true`: a failed read must not tell an org with
   * working email that it has none, and the delivery path checks the same switch again
   * for real.
   */
  const delivery = useFetch<boolean>(
    async (signal) => {
      const res = await api.getReportDeliveryStatus({ signal });
      return res.success && res.data ? res.data.emailAvailable : true;
    },
    [enabled],
    { enabled },
  );
  const policy = useFetch<ReportPolicy | null>(
    async (signal) => {
      const res = await api.getReportPolicy({ signal });
      if (res.success && res.data) return res.data.policy;
      throw new Error('Could not load the report policy');
    },
    [enabled],
    { enabled },
  );

  const loading = definitions.loading || recipients.loading || policy.loading;
  const loadError = definitions.error ?? recipients.error ?? policy.error;
  const errorMessage = action.error ?? (loadError ? loadError.message : null);
  const refetch = useCallback(async () => {
    const results = await Promise.all([definitions.refetch(), recipients.refetch(), policy.refetch()]);
    return results.every(Boolean);
  }, [definitions.refetch, recipients.refetch, policy.refetch]);

  useEffect(() => { onStatus({ loading, error: errorMessage, refetch }); }, [loading, errorMessage, refetch, onStatus]);

  const selected = useMemo(
    () => (definitions.data ?? []).find((d) => d.id === selectedId) ?? null,
    [definitions.data, selectedId],
  );

  // The selected definition's run history. Keyed on the definition, so switching
  // reports does not show the previous one's runs.
  const runs = useFetch<ReportRun[]>(
    async (signal) => {
      if (!selectedId) return [];
      const res = await api.listReportRuns(selectedId, { signal });
      if (res.success && res.data) return res.data.runs;
      throw new Error('Could not load the run history');
    },
    [selectedId, enabled],
    { enabled: enabled && !!selectedId },
  );

  const run = useFetch<ReportRun | null>(
    async (signal) => {
      if (!selectedRunId) return null;
      const res = await api.getReportRun(selectedRunId, { signal });
      if (res.success && res.data) return res.data.run;
      throw new Error('Could not load the report');
    },
    [selectedRunId, enabled],
    { enabled: enabled && !!selectedRunId },
  );

  const generate = async (definitionId: string, regenerate = false) => {
    await action.run(
      async () => {
        const res = await api.generateReportRun(definitionId, regenerate ? { regenerate: true } : {});
        if (!res.success || !res.data) throw new Error('Could not generate the report');
        return res.data.run;
      },
      {
        onSuccess: (created) => {
          setSelectedRunId(created.id);
          void runs.refetch();
        },
      },
    );
  };

  const setActive = async (definition: ReportDefinition, isActive: boolean) => {
    await action.run(
      async () => { await api.updateReportDefinition(definition.id, { isActive }); },
      { onSuccess: () => { void definitions.refetch(); } },
    );
  };

  const remove = async (definition: ReportDefinition) => {
    await action.run(
      async () => { await api.deleteReportDefinition(definition.id); },
      {
        onSuccess: () => {
          if (selectedId === definition.id) { setSelectedId(null); setSelectedRunId(null); }
          void definitions.refetch();
        },
      },
    );
  };

  if (!enabled) {
    return (
      <div className="space-y-3">
        <FeatureLock flag="stakeholder_reports" />
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-5 h-5 text-fg-subtle" aria-hidden="true" />
            <h3 className="h3">Scheduled reports for the people you report to</h3>
          </div>
          <p className="text-sm text-fg-muted">
            A saved report runs every week, month or quarter, freezes that period&apos;s numbers so they never
            change under the reader, and waits for you to add the context the data cannot — then goes out by
            email, in-app, Slack or Teams, or as a link for someone with no account here.
          </p>
        </Card>
        {/* The offer, under the explanation: one watermarked sample from the org's own
            numbers. Not shown on a billing-disabled install — those orgs run as the
            unlimited tier, hold the feature, and never reach this branch at all. */}
        <ReportPreview canAuthor={canAuthor} readOnly={readOnly} />
      </div>
    );
  }

  const list = definitions.data ?? [];

  return (
    <div className="space-y-4">
      <TabBar
        items={INNER_TABS}
        activeId={inner}
        onSelect={(id) => setInner(id as InnerTab)}
        idPrefix="stakeholder"
        ariaLabel="Stakeholder reports"
      />
      <ErrorAlert message={errorMessage} onDismiss={action.reset} onRetry={refetch} />

      <div {...tabPanelProps('stakeholder', inner)}>
        {inner === 'reports' && (
          <div className="space-y-4">
            {canAuthor && !creating && !editing && (
              <Button size="sm" onClick={() => setCreating(true)} readOnly={readOnly}>New report</Button>
            )}

            {(creating || editing) && (
              <ReportDefinitionForm
                {...(editing ? { definition: editing } : {})}
                recipients={recipients.data ?? []}
                canRollup={canRollup}
                emailAvailable={delivery.data ?? true}
                readOnly={readOnly}
                onSaved={(saved) => {
                  setCreating(false);
                  setEditing(null);
                  setSelectedId(saved.id);
                  void definitions.refetch();
                }}
                onCancel={() => { setCreating(false); setEditing(null); }}
              />
            )}

            {!loading && list.length === 0 && !creating && (
              <EmptyState
                compact
                icon={CalendarClock}
                title="No saved reports yet"
                description="A saved report runs on a schedule and freezes each period's numbers, so a manager who reads it on Monday sees the same figures on Friday."
                {...(canAuthor ? { actionLabel: 'New report', onAction: () => setCreating(true) } : {})}
              />
            )}

            {list.map((definition) => (
              <Card key={definition.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      type="button"
                      className="text-left font-medium text-fg hover:underline"
                      onClick={() => {
                        setSelectedId(definition.id === selectedId ? null : definition.id);
                        setSelectedRunId(null);
                      }}
                    >
                      {definition.name}
                    </button>
                    <p className="text-xs text-fg-muted">
                      {definition.cadence} · {definition.timezone}
                      {definition.cadence === 'weekly' && ` · weeks start ${definition.weekStart}`}
                      {' · '}
                      {definition.recipients.length} {definition.recipients.length === 1 ? 'recipient' : 'recipients'}
                      {definition.autoSend && ' · publishes automatically'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {definition.isActive
                      ? <Badge color="green">Active</Badge>
                      : <Badge color="yellow">Paused</Badge>}
                    {canAuthor && (
                      <>
                        <Button size="xs" variant="secondary" onClick={() => generate(definition.id)} loading={action.loading} readOnly={readOnly}>
                          <RefreshCw className="w-3 h-3" aria-hidden="true" /> Generate
                        </Button>
                        <Button size="xs" variant="secondary" onClick={() => setEditing(definition)} readOnly={readOnly}>Edit</Button>
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => setActive(definition, !definition.isActive)}
                          readOnly={readOnly}
                        >
                          {definition.isActive
                            ? <><Pause className="w-3 h-3" aria-hidden="true" /> Pause</>
                            : <><Play className="w-3 h-3" aria-hidden="true" /> Resume</>}
                        </Button>
                        <Button size="xs" variant="danger" onClick={() => remove(definition)} readOnly={readOnly}>
                          <Trash2 className="w-3 h-3" aria-hidden="true" />
                          <span className="sr-only">Delete {definition.name}</span>
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* A paused report explains itself. "Paused" with no reason is a
                    support ticket; the reason names the fix. */}
                {!definition.isActive && definition.pausedReason && (
                  <p className="mt-2 text-sm text-warning-strong">
                    {PAUSE_REASONS[definition.pausedReason] ?? 'This report is paused.'}
                  </p>
                )}

                {selectedId === definition.id && (
                  <div className="mt-3 border-t border-default pt-3">
                    {runs.loading && <p className="text-sm text-fg-muted">Loading the run history…</p>}
                    {!runs.loading && (runs.data ?? []).length === 0 && (
                      <p className="text-sm text-fg-muted">
                        No periods have been reported yet. Generate one to see what a recipient would read.
                      </p>
                    )}
                    {(runs.data ?? []).length > 0 && (
                      <ul className="flex flex-wrap gap-2">
                        {(runs.data ?? []).map((r) => (
                          <li key={r.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedRunId(r.id)}
                              className={['btn btn-xs', selectedRunId === r.id ? 'btn-primary' : 'btn-secondary'].join(' ')}
                            >
                              {r.periodLabel}
                              {r.version > 1 && ` v${r.version}`}
                              {r.status === 'published' && ' ✓'}
                              {r.status === 'failed' && ' ✕'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {selected && canAuthor && (runs.data ?? []).some((r) => r.id === selectedRunId) && (
                      <Button
                        size="xs"
                        variant="secondary"
                        className="mt-2"
                        onClick={() => generate(definition.id, true)}
                        loading={action.loading}
                        readOnly={readOnly}
                      >
                        Regenerate this period as a new version
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            ))}

            {run.data && (
              <ReportReview
                run={run.data}
                canAuthor={canAuthor}
                canShare={canShare}
                externalSharing={policy.data?.externalSharing ?? false}
                readOnly={readOnly}
                onChanged={() => { void run.refetch(); void runs.refetch(); }}
              />
            )}
          </div>
        )}

        {inner === 'recipients' && (
          <ReportRecipients
            recipients={recipients.data ?? []}
            policy={policy.data ?? null}
            canAuthor={canAuthor}
            readOnly={readOnly}
            onChanged={() => { void recipients.refetch(); }}
          />
        )}

        {inner === 'settings' && (
          <ReportPolicyCard
            policy={policy.data ?? null}
            canEdit={canAdmin}
            readOnly={readOnly}
            onChanged={() => { void policy.refetch(); }}
          />
        )}
      </div>
    </div>
  );
}
