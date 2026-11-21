// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Check, Download, FileDiff, RotateCcw, Wrench, X } from 'lucide-react';
import { REMEDIATION_ROLLOUT_START_FAILED, rolloutStartFailureText } from '@pipeline-builder/api-core/plugin-scan';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import {
  PLUGIN_REMEDIATION_STAGE_LABELS, REMEDIATION_FIX_METHOD_LABELS, REMEDIATION_PROPOSE_REASON_LABELS,
  REMEDIATION_ROLLOUT_STATUS_LABELS, REMEDIATION_STAGE_COLORS, packageTypeLabel, remainingReasonLabel,
} from '@/lib/plugin-remediation';
import type { PluginRemediationDto } from '@/types/plugin-remediation';
import { RemediationOffNotice } from './RemediationOffNotice';

/** Stages a new attempt may be started from (the retry route's own rule). */
const RETRYABLE = new Set(['failed', 'needs_owner', 'needs_review']);

/** A published fix whose rollout start the sweep gave up on: Retry starts that rollout again (the same route). */
export const rolloutStartGivenUp = (r: Pick<PluginRemediationDto, 'stage' | 'error'>): boolean =>
  r.stage === 'published' && r.error === REMEDIATION_ROLLOUT_START_FAILED;

/** The stage as a badge, in the shared status colours. */
export function RemediationStageBadge({ stage }: { stage: PluginRemediationDto['stage'] }) {
  return <Badge color={REMEDIATION_STAGE_COLORS[stage] ?? 'gray'}>{PLUGIN_REMEDIATION_STAGE_LABELS[stage] ?? stage}</Badge>;
}

/**
 * A unified diff as coloured lines — the same tokens the moderators' review
 * diff (ReviewDiffView's line diff) uses, applied to the patch file the
 * remediation stored. Text only: the patch never carries source beyond the
 * named packages' lines or the one overlay layer.
 */
export function PatchDiffView({ patch }: { patch: string }) {
  const lines = patch.replace(/\n$/, '').split('\n');
  return (
    <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-default bg-surface-muted p-2 text-xs leading-5" data-testid="remediation-patch">
      {lines.map((l, i) => {
        const header = l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@') || l.startsWith('diff ');
        const cls = header ? 'text-fg font-medium'
          : l.startsWith('+') ? 'bg-success-bg text-success-strong'
            : l.startsWith('-') ? 'bg-danger-bg text-danger-strong' : 'text-fg-muted';
        return <div key={i} className={cls}>{l || ' '}</div>;
      })}
    </pre>
  );
}

type PendingAction = 'approve' | 'reject' | 'retry' | null;

/** The reject route's `reason` cap (api-core `PluginRemediationDecisionSchema`). */
export const REJECT_REASON_MAX = 1000;

/** The decision and retry routes answer 503 while the operator has remediation turned off (PLUGIN_REMEDIATION_ENABLED=false). */
export const isRemediationOperatorOff = (err: unknown): boolean => err instanceof ApiError && err.statusCode === 503;

/** Approve and retry answer 409 PLUGIN_REMEDIATION_MODE_OFF while the organization's own remediation mode is off. */
export const isRemediationModeOff = (err: unknown): boolean => err instanceof ApiError && err.code === 'PLUGIN_REMEDIATION_MODE_OFF';

/**
 * One remediation: its stage, the fix version once published, the findings it
 * cleared and the ones it left (each with why), the patch diff, and — in
 * propose mode — Approve and publish / Reject, each behind a step-up. Approve,
 * Reject and Retry share ONE busy state: while any of them runs, all three are
 * disabled (the server would only answer the second with a 409). Reject takes
 * an optional reason, sent to the route and kept on its audit row.
 */
export function RemediationCard({ remediation, canWrite, isSystemOrg = false, onChanged, onOpenPlugin }: {
  remediation: PluginRemediationDto;
  /** `plugins:write`: approve, reject and retry. */
  canWrite: boolean;
  /** The active org is the system org (the Official export download). */
  isSystemOrg?: boolean;
  /** Called with the server's answer after a decision or retry. */
  onChanged?: (next: PluginRemediationDto | null) => void;
  /** Open a plugin version by id (the fix version link). */
  onOpenPlugin?: (pluginId: string) => void;
}) {
  const r = remediation;
  const toast = useToast();
  const [pending, setPending] = useState<PendingAction>(null);
  // The decision or retry in flight (one at a time across all three buttons).
  const [busy, setBusy] = useState<Exclude<PendingAction, null> | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showPatch, setShowPatch] = useState(false);
  // Set when a decision or retry answered 503: the card then says so with the shared notice instead of an error toast.
  const [operatorOff, setOperatorOff] = useState(false);
  // Set when approve or retry answered PLUGIN_REMEDIATION_MODE_OFF: the org's own mode is off.
  const [modeOff, setModeOff] = useState(false);
  const patchQ = useFetch(async () => api.getPluginRemediationPatch(r.id), [r.id], { enabled: showPatch && r.hasPatch });

  const decide = async (action: 'approve' | 'reject', token: string) => {
    setBusy(action);
    const reason = rejectReason.trim().slice(0, REJECT_REASON_MAX);
    try {
      const res = action === 'approve'
        ? await api.approvePluginRemediation(r.id, {}, token)
        : await api.rejectPluginRemediation(r.id, reason ? { reason } : {}, token);
      toast.success(action === 'approve' ? `Fix${r.toVersion ? ` ${r.toVersion}` : ''} approved and publishing` : 'Fix rejected');
      setPending(null);
      onChanged?.(res.data ?? null);
    } catch (err) {
      if (isRemediationOperatorOff(err)) setOperatorOff(true);
      else if (isRemediationModeOff(err)) setModeOff(true);
      else toast.error(formatError(err, action === 'approve' ? 'Could not approve the fix' : 'Could not reject the fix'));
      setPending(null);
    } finally {
      setBusy(null);
    }
  };

  // Retry on a given-up rollout start restarts that rollout in place; on anything else it queues a new attempt.
  const startGivenUp = rolloutStartGivenUp(r);
  const retryM = useMutation({
    fn: async (token: string) => (await api.retryPluginRemediation(r.id, token)).data ?? null,
    scopeKey: r.id,
    errorFallback: startGivenUp ? 'Could not restart the rollout' : 'Could not retry the remediation',
    onSuccess: (dto) => {
      if (!startGivenUp) toast.success('A new remediation attempt was queued');
      else if (dto?.stage === 'rolling_out') toast.success('Rollout started');
      else if (dto?.error === REMEDIATION_ROLLOUT_START_FAILED) toast.warning(`Rollout didn't start: ${rolloutStartFailureText(dto.rolloutStart?.lastStatus)}`);
      else toast.info(`Rollout didn't start yet (${rolloutStartFailureText(dto?.rolloutStart?.lastStatus)}); it is retried nightly`);
      onChanged?.(dto);
    },
    onError: (err, message) => {
      if (isRemediationOperatorOff(err)) setOperatorOff(true);
      else if (isRemediationModeOff(err)) setModeOff(true);
      else toast.error(message);
    },
  });

  const runRetry = async (token: string) => {
    setBusy('retry');
    try {
      await retryM.run(token);
    } finally {
      setBusy(null);
    }
  };
  const anyBusy = busy !== null || retryM.pending;

  const exportM = useMutation({
    fn: async () => {
      const { blob, filename } = await api.downloadPluginRemediationExport(r.id);
      triggerBlobDownload(blob, filename);
    },
    scopeKey: r.id,
    errorFallback: 'Export download failed',
    toast: { error: true },
  });
  const downloadExport = () => { void exportM.run(); };

  // The approve route records the decision and leaves the stage at awaiting_approval while the job rebuilds and
  // publishes; a second Approve or Reject would only answer 409.
  const awaitingDecision = r.stage === 'awaiting_approval' && !r.decidedAt;
  // The version it fixed was purged: the record (and its patch) stays, but there is nothing left to rebuild,
  // so the server refuses approve and retry (409).
  const sourcePurged = r.pluginId === null;
  const counts = r.rollout?.counts;
  const wavePipelines = [...new Set((r.rollout?.waves ?? []).flatMap((w) => w.pipelineIds))];
  return (
    <div className="space-y-2 rounded-md border border-default p-3 text-xs" data-testid="remediation-card">
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
        <span className="font-medium text-fg">Remediation of {r.pluginName} {r.fromVersion}</span>
        <RemediationStageBadge stage={r.stage} />
        {r.attempt > 1 && <Badge color="gray">Attempt {r.attempt}</Badge>}
        <span className="text-fg-muted">updated <RelativeTime value={r.updatedAt} /></span>
      </div>

      {r.toVersion && (
        <p data-testid="remediation-fix-version">
          Fix version{' '}
          {r.toPluginId && onOpenPlugin ? (
            <button type="button" className="action-link font-mono" onClick={() => onOpenPlugin(r.toPluginId as string)}>{r.toVersion}</button>
          ) : (
            <Link href={`/dashboard/plugins?q=${encodeURIComponent(r.pluginName)}`} className="action-link font-mono">{r.toVersion}</Link>
          )}
          {awaitingDecision ? ' (built, waiting for approval)' : r.stage === 'awaiting_approval' ? ' (approved, publishing)' : r.publishedAt ? ' published' : ''}
          {r.publishedAt && <> <RelativeTime value={r.publishedAt} /></>}
          {r.fixMethods.length > 0 && <span className="text-fg-muted"> · {r.fixMethods.map((m) => REMEDIATION_FIX_METHOD_LABELS[m] ?? m).join(', ')}</span>}
        </p>
      )}

      {awaitingDecision && r.proposeReasons.length > 0 && (
        <ul className="list-disc pl-4 text-fg-muted" aria-label="Why this fix waits for approval">
          {r.proposeReasons.map((p) => <li key={p}>{REMEDIATION_PROPOSE_REASON_LABELS[p] ?? p}</li>)}
        </ul>
      )}

      {r.cleared.length > 0 && (
        <div>
          <p className="font-medium text-success-strong">Cleared ({r.cleared.length})</p>
          <ul className="space-y-0.5 font-mono" aria-label="Cleared findings">
            {r.cleared.map((c) => (
              <li key={`${c.id}:${c.purl}`}>
                {c.id} {c.packageName} {c.fromVersion} → {c.toVersion ?? 'removed'}
                <span className="font-sans text-fg-muted"> · {packageTypeLabel(c.packageType)} · {REMEDIATION_FIX_METHOD_LABELS[c.method] ?? c.method}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.remaining.length > 0 && (
        <div>
          <p className="font-medium text-warning-strong">Left for the owner ({r.remaining.length})</p>
          <ul className="space-y-0.5" aria-label="Remaining findings">
            {r.remaining.map((f) => (
              <li key={`${f.id}:${f.purl}`}>
                <span className="font-mono">{f.id} {f.packageName}@{f.packageVersion}</span>
                {f.fixedIn.length > 0 && <span className="font-mono text-fg-muted"> → {f.fixedIn.join(', ')}</span>}
                {f.kev && <> <Badge color="red">KEV</Badge></>}
                <span className="text-fg-muted"> · {remainingReasonLabel(f.reason, f.requiredLevel)}</span>
                {f.detail && <span className="font-mono text-fg-muted"> ({f.detail})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.rollout && counts && (
        <p data-testid="remediation-rollout">
          Rollout: {REMEDIATION_ROLLOUT_STATUS_LABELS[r.rollout.status] ?? r.rollout.status}
          {' · '}{counts.moved}/{counts.eligible} pipelines moved
          {counts.proposed > 0 && ` · ${counts.proposed} proposed`}
          {counts.changeRequested > 0 && ` · ${counts.changeRequested} change requests`}
          {counts.rolledBack > 0 && ` · ${counts.rolledBack} rolled back`}
          {counts.failed > 0 && ` · ${counts.failed} failed`}
          {counts.skippedOptOut > 0 && ` · ${counts.skippedOptOut} opted out`}
          {counts.skippedRunner > 0 && ` · ${counts.skippedRunner} skipped (runner unhealthy)`}
          {(counts.waitingChangeRequest ?? 0) > 0 && ` · ${counts.waitingChangeRequest} waiting on another change request`}
          {(counts.movedPendingRedeploy ?? 0) > 0 && ` · ${counts.movedPendingRedeploy} moved, redeploy pending`}
        </p>
      )}

      {wavePipelines.length > 0 && (
        <p data-testid="remediation-pipelines">
          Pipelines in the rollout:{' '}
          {wavePipelines.slice(0, 10).map((id, i) => (
            <span key={id}>{i > 0 && ', '}<Link href={`/dashboard/pipelines/${encodeURIComponent(id)}`} className="action-link font-mono">{id.slice(0, 8)}</Link></span>
          ))}
          {wavePipelines.length > 10 && ` and ${wavePipelines.length - 10} more`}
        </p>
      )}

      {r.rolledBackPipelineIds.length > 0 && (
        <p data-testid="remediation-rolled-back">
          Rolled back after a failed run:{' '}
          {r.rolledBackPipelineIds.slice(0, 10).map((id, i) => (
            <span key={id}>{i > 0 && ', '}<Link href={`/dashboard/pipelines/${encodeURIComponent(id)}`} className="action-link font-mono">{id.slice(0, 8)}</Link></span>
          ))}
          {r.rolledBackPipelineIds.length > 10 && ` and ${r.rolledBackPipelineIds.length - 10} more`}
        </p>
      )}

      {operatorOff && <RemediationOffNotice />}
      {modeOff && !operatorOff && (
        <Callout variant="neutral" title="Remediation is turned off for this organization">
          Turn plugin security fixes back on in the organization&apos;s settings to approve or retry a fix.
        </Callout>
      )}

      {sourcePurged && (
        <p className="text-fg-muted" data-testid="remediation-source-purged">
          {r.pluginName} {r.fromVersion} was purged. This record of its fix stays, but it can no longer be approved or retried.
        </p>
      )}

      {startGivenUp ? (
        <p className="text-danger-strong" data-testid="remediation-rollout-start-failed">
          Rollout didn&apos;t start: {rolloutStartFailureText(r.rolloutStart?.lastStatus)}
          {r.rolloutStart && r.rolloutStart.attempts > 1 && ` (${r.rolloutStart.attempts} attempts)`}.
          {' '}The fix version is published, so owners can still choose it; Retry starts the rollout again.
        </p>
      ) : r.error && <p className="text-danger-strong" data-testid="remediation-error">Error: <span className="font-mono">{r.error}</span></p>}

      <div className="flex flex-wrap gap-2">
        {r.hasPatch && (
          <Button variant="outline" size="xs" onClick={() => setShowPatch((s) => !s)} aria-expanded={showPatch}>
            <FileDiff className="mr-1 h-3.5 w-3.5" aria-hidden />{showPatch ? 'Hide patch' : 'Show patch'}
          </Button>
        )}
        {r.hasExport && isSystemOrg && canWrite && (
          <Button variant="outline" size="xs" onClick={downloadExport} loading={exportM.pending}>
            <Download className="mr-1 h-3.5 w-3.5" aria-hidden />Download patch for deploy/plugins
          </Button>
        )}
        {canWrite && awaitingDecision && (
          <>
            {!sourcePurged && (
              <Button variant="success" size="xs" onClick={() => setPending('approve')} disabled={anyBusy} loading={busy === 'approve'}>
                <Check className="mr-1 h-3.5 w-3.5" aria-hidden />Approve and publish
              </Button>
            )}
            <Button variant="danger-outline" size="xs" onClick={() => { setRejectReason(''); setPending('reject'); }} disabled={anyBusy} loading={busy === 'reject'}>
              <X className="mr-1 h-3.5 w-3.5" aria-hidden />Reject
            </Button>
          </>
        )}
        {canWrite && startGivenUp && (
          <Button variant="outline" size="xs" onClick={() => setPending('retry')} disabled={anyBusy} loading={busy === 'retry' || retryM.pending}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />Retry rollout
          </Button>
        )}
        {canWrite && !sourcePurged && RETRYABLE.has(r.stage) && (
          <Button variant="outline" size="xs" onClick={() => setPending('retry')} disabled={anyBusy} loading={busy === 'retry' || retryM.pending}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />Retry remediation
          </Button>
        )}
      </div>

      {showPatch && (patchQ.loading && !patchQ.data ? (
        <Skeleton className="h-16 w-full" />
      ) : patchQ.error ? (
        <RetryError message={formatError(patchQ.error, 'Could not load the patch')} onRetry={patchQ.refetch} />
      ) : patchQ.data ? <PatchDiffView patch={patchQ.data} /> : null)}

      {pending && (
        <StepUpModal
          title={pending === 'approve' ? 'Approve and publish this fix?' : pending === 'reject' ? 'Reject this fix?' : startGivenUp ? 'Start this rollout again?' : 'Retry this remediation?'}
          action={pending === 'approve'
            ? `Publish ${r.pluginName} ${r.toVersion ?? ''} as the fix for ${r.fromVersion}`
            : pending === 'reject'
              ? `Reject the fix for ${r.pluginName} ${r.fromVersion}; the version stays flagged`
              : startGivenUp
                ? `Start the rollout of ${r.pluginName} ${r.toVersion ?? ''} to the pipelines on ${r.fromVersion} again`
                : `Start a new remediation attempt for ${r.pluginName} ${r.fromVersion} (counts toward today's limit)`}
          details={pending === 'reject' ? (
            <div className="space-y-1">
              <label htmlFor={`remediation-reject-reason-${r.id}`} className="block text-fg">Reason (optional)</label>
              <Textarea
                id={`remediation-reject-reason-${r.id}`}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                maxLength={REJECT_REASON_MAX}
                rows={3}
                placeholder="Why this fix should not be published — kept with the decision and its audit record"
                data-testid="remediation-reject-reason"
              />
            </div>
          ) : undefined}
          onConfirmed={(token) => {
            if (pending === 'retry') { setPending(null); void runRetry(token); } else { void decide(pending, token); }
          }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}

/**
 * The newest remediation of one plugin version, for the version's detail view
 * (beside "Flagged by rescan"). Renders nothing while a version has none; says
 * so plainly when the operator turned remediation off.
 */
export function PluginRemediationSection({ pluginId, canWrite, isSystemOrg = false, onOpenPlugin }: {
  pluginId: string;
  canWrite: boolean;
  isSystemOrg?: boolean;
  onOpenPlugin?: (pluginId: string) => void;
}) {
  const q = useFetch(async (signal) => {
    const res = await api.listPluginRemediations({ pluginId, limit: 1 }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load remediation');
    return res.data;
  }, [pluginId]);
  if (q.loading && !q.data) return <Skeleton className="h-10 w-full" />;
  if (q.error) return <RetryError message={formatError(q.error, 'Failed to load remediation')} onRetry={q.refetch} />;
  if (!q.data) return null;
  const latest = q.data.remediations[0];
  if (!q.data.enabled) return <RemediationOffNotice className="mt-2" />;
  if (!latest) return null;
  return (
    <div className="mt-2" data-testid="plugin-remediation-section">
      <RemediationCard remediation={latest} canWrite={canWrite} isSystemOrg={isSystemOrg} onChanged={() => q.refetch()} onOpenPlugin={onOpenPlugin} />
    </div>
  );
}
