// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import type { Permission } from '@pipeline-builder/api-core/permissions';
import { History, Lock } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { formatDateTime, shortDigest } from '@/lib/format';
import {
  isActionable, isDeferred, reclaimableText, retentionActionLabel, retentionConfigText, retentionOutcomeLabel,
  retentionRuleLabel, retentionStateColor, retentionStateLabel, retentionTotalsLines, runAvailability, runOutcome,
} from '@/lib/plugin-retention';
import type { RetentionPluginEntry, RetentionReport } from '@/types/plugin-retention';

interface Props {
  /** Held permissions (read affordances: a read-only session still reads). */
  holds: (permission: Permission) => boolean;
  /** Effective permissions (write affordances). */
  can: (permission: Permission) => boolean;
  readOnly: boolean;
}

/**
 * Superseded system plugin version retention: the dry run of what a pass would
 * keep, deprecate, yank or reverse and why, with the reclaimable bytes, and
 * "Run a pass now" behind a step-up. System org + `plugins:moderate` + aal2 (the
 * Ecosystem console enforces the org and the session; this panel shows a
 * locked state without the permission rather than disappearing).
 */
export function RetentionPanel({ holds, can, readOnly }: Props) {
  if (!holds('plugins:moderate')) {
    return (
      <SectionCard title="Retention" icon={History}>
        <Callout variant="neutral" icon={Lock} title="Locked">
          <p data-testid="retention-locked">Plugin version retention needs the plugins:moderate permission (Ecosystem Manager).</p>
        </Callout>
      </SectionCard>
    );
  }
  return <RetentionPanelBody can={can} readOnly={readOnly} />;
}

function RetentionPanelBody({ can, readOnly }: { can: Props['can']; readOnly: boolean }) {
  const toast = useToast();
  const plan = useFetch<RetentionReport>(async (signal) => {
    const res = await api.getRetentionPlan({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the retention plan');
    return res.data;
  }, []);
  const [confirming, setConfirming] = useState(false);
  const [lastRun, setLastRun] = useState<RetentionReport | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const run = runAvailability({ mayModerate: can('plugins:moderate'), readOnly });
  const report = plan.data;

  const confirmRun = async (token: string) => {
    setRunError(null);
    try {
      const res = await api.runRetentionPass(token);
      if (!res.success || !res.data) throw new Error(res.message || 'The retention pass failed');
      setLastRun(res.data);
      toast.success('Retention pass finished');
      void plan.refetch();
    } catch (err) {
      setRunError(formatError(err, 'The retention pass failed'));
    }
  };

  const shown = report ? report.plugins.filter((p) => showAll || p.refusedReason || p.versions.some(isActionable)) : [];

  return (
    <SectionCard
      title="Retention"
      icon={History}
      description="Superseded system plugin versions: what a pass keeps and why, and what it would deprecate, yank or reverse. A dry run; nothing changes until a pass runs."
      actions={(
        <Button
          variant="secondary"
          className="text-xs"
          onClick={() => setConfirming(true)}
          disabled={!run.allowed || !report}
          title={run.reason ?? 'Run one retention pass now (re-verifies your identity; audited)'}
        >
          Run a pass now
        </Button>
      )}
    >
      {plan.loading && !report && <LoadingSpinner />}
      {plan.error && <RetryError message={formatError(plan.error, 'Failed to load the retention plan')} onRetry={plan.refetch} />}
      {report && (
        <div className="space-y-4 text-sm" data-testid="retention-panel">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={report.enabled ? 'green' : 'gray'}>{report.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <span className="text-xs text-fg-muted" data-testid="retention-config">{retentionConfigText(report)}</span>
          </div>
          {!report.enabled && (
            <p className="text-xs text-fg-muted" data-testid="retention-disabled-note">
              The scheduled pass is off (PLUGIN_RETENTION_ENABLED). &quot;Run a pass now&quot; still acts: it deprecates, yanks and reverses for real.
            </p>
          )}
          {!run.allowed && run.reason && <p className="text-xs text-fg-muted" data-testid="retention-run-blocked">{run.reason}.</p>}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5" aria-label="Retention totals" data-testid="retention-totals">
            {retentionTotalsLines(report).map((l) => (
              <div key={l.label}>
                <dt className="text-xs text-fg-muted">{l.label}</dt>
                <dd className="font-medium text-fg" data-total={l.label}>{l.value}</dd>
              </div>
            ))}
          </dl>
          {report.storage.incomplete && (
            <p className="text-xs text-fg-muted">The registry could not measure every image, so reclaimable bytes are not shown.</p>
          )}

          {runError && <Callout variant="danger" title="Pass not run"><p data-testid="retention-run-error">{runError}</p></Callout>}
          {lastRun && <RunResult report={lastRun} />}

          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show plugins with nothing to retire
          </label>
          {shown.length === 0 && <p className="text-sm text-fg-subtle">Nothing to retire.</p>}
          <ul className="space-y-3" aria-label="Retention by plugin">
            {shown.map((p) => <PluginRow key={p.name} plugin={p} storage={report.storage} />)}
          </ul>
          <p className="text-2xs text-fg-subtle">Generated {formatDateTime(report.generatedAt)}</p>
        </div>
      )}
      {confirming && report && (
        <StepUpModal
          title="Run a retention pass now?"
          action="Run one plugin version retention pass"
          details={(
            <div className="space-y-2 text-sm" data-testid="retention-run-confirm">
              <p>
                This deprecates {report.totals.deprecate}, yanks {report.totals.yank} and reverses {report.totals.reverse} version(s)
                as of the dry run, up to {report.batch} actions, and notifies the orgs that use them. It is audited.
              </p>
              {!report.enabled && <p className="text-fg-muted">The scheduled pass is disabled; this manual run acts anyway.</p>}
            </div>
          )}
          onConfirmed={confirmRun}
          onClose={() => setConfirming(false)}
        />
      )}
    </SectionCard>
  );
}

function PluginRow({ plugin, storage }: { plugin: RetentionPluginEntry; storage: RetentionReport['storage'] }) {
  return (
    <li className="rounded-lg border border-default" data-plugin={plugin.name}>
      <div className="flex flex-wrap items-center gap-2 border-b border-default px-3 py-2">
        <span className="font-mono text-fg">{plugin.name}</span>
        {plugin.listed && <Badge color="blue">Listed</Badge>}
        <span className="ml-auto text-xs text-fg-muted">Reclaimable: {reclaimableText(plugin.marginalBytes, storage)}</span>
      </div>
      {plugin.refusedReason && <p className="px-3 py-2 text-xs text-danger" data-testid="retention-refused">Refused this pass: {retentionRuleLabel(plugin.refusedReason)}</p>}
      <table className="w-full text-xs">
        <thead className="text-left text-fg-muted">
          <tr>
            <th className="px-3 py-1 font-medium">Version</th>
            <th className="px-3 py-1 font-medium">Decision</th>
            <th className="px-3 py-1 font-medium">Why</th>
            <th className="px-3 py-1 font-medium">Bytes</th>
          </tr>
        </thead>
        <tbody>
          {plugin.versions.map((v) => (
            <tr key={v.version} className="border-t border-default" data-version={v.version} data-state={v.state}>
              <td className="px-3 py-1 font-mono">
                {v.version}
                {v.digest && <span className="ml-2 text-fg-subtle" title={v.digest}>{shortDigest(v.digest)}</span>}
              </td>
              <td className="px-3 py-1">
                <span className="flex flex-wrap items-center gap-1">
                  <Badge color={retentionStateColor(v.state)}>{retentionStateLabel(v.state)}</Badge>
                  {isDeferred(v) && <Badge color="purple">Deferred</Badge>}
                  {v.action && v.action !== 'deferred' && <Badge color={v.action === 'failed' ? 'red' : 'gray'}>{retentionActionLabel(v.action)}</Badge>}
                </span>
              </td>
              <td className="px-3 py-1">
                {retentionRuleLabel(v.rule)}
                {v.yankAfter && <span className="block text-fg-subtle">Yank after {formatDateTime(v.yankAfter)}</span>}
                {v.error && <span className="block text-fg-subtle">{v.error}</span>}
              </td>
              <td className="px-3 py-1">{isActionable(v) ? reclaimableText(v.marginalBytes, storage) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}

function RunResult({ report }: { report: RetentionReport }) {
  const out = runOutcome(report);
  return (
    <Callout variant={out.problems.length > 0 || out.collectionProblems.length > 0 ? 'warning' : 'success'} title="Pass results">
      <div className="space-y-1 text-xs" data-testid="retention-run-result">
        <p>
          {out.actions.length === 0
            ? 'No version was acted on.'
            : out.actions.map((a) => `${retentionActionLabel(a.action)}: ${a.count}`).join(' · ')}
        </p>
        {out.collected.length > 0 && (
          <p>Images: {out.collected.map((c) => `${retentionOutcomeLabel(c.outcome)}: ${c.count}`).join(' · ')}</p>
        )}
        {out.problems.length > 0 && (
          <ul className="list-disc pl-4" aria-label="Errors">
            {out.problems.map((p) => <li key={p.ref}><span className="font-mono">{p.ref}</span> {retentionActionLabel(p.action).toLowerCase()}: {p.error}</li>)}
          </ul>
        )}
        {out.collectionProblems.length > 0 && (
          <ul className="list-disc pl-4" aria-label="Collection problems">
            {out.collectionProblems.map((c) => (
              <li key={`${c.name}@${c.version}`}>
                <span className="font-mono">{c.name}@{c.version}</span> {retentionOutcomeLabel(c.outcome).toLowerCase()}
                {c.rule ? `: ${retentionRuleLabel(c.rule)}` : ''}{c.error ? `: ${c.error}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Callout>
  );
}
