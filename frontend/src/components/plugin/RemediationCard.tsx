// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Check, Download, FileDiff, RotateCcw, Wrench, X } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
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

type PendingAction = 'approve' | 'reject' | null;

/**
 * One remediation: its stage, the fix version once published, the findings it
 * cleared and the ones it left (each with why), the patch diff, and — in
 * propose mode — Approve and publish / Reject, each behind a step-up.
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
  const [showPatch, setShowPatch] = useState(false);
  const patchQ = useFetch(async () => api.getPluginRemediationPatch(r.id), [r.id], { enabled: showPatch && r.hasPatch });

  const decide = async (action: 'approve' | 'reject', token: string) => {
    try {
      const res = action === 'approve'
        ? await api.approvePluginRemediation(r.id, {}, token)
        : await api.rejectPluginRemediation(r.id, {}, token);
      toast.success(action === 'approve' ? `Fix${r.toVersion ? ` ${r.toVersion}` : ''} approved and publishing` : 'Fix rejected');
      setPending(null);
      onChanged?.(res.data ?? null);
    } catch (err) {
      toast.error(formatError(err, action === 'approve' ? 'Could not approve the fix' : 'Could not reject the fix'));
      setPending(null);
    }
  };

  const retryM = useMutation({
    fn: async () => (await api.retryPluginRemediation(r.id)).data ?? null,
    scopeKey: r.id,
    errorFallback: 'Could not retry the remediation',
    toast: { success: 'A new remediation attempt was queued', error: true },
    onSuccess: (dto) => onChanged?.(dto),
  });
  const retry = () => { void retryM.run(); };

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
          {r.stage === 'awaiting_approval' ? ' (built, waiting for approval)' : r.publishedAt ? ' published' : ''}
          {r.publishedAt && <> <RelativeTime value={r.publishedAt} /></>}
          {r.fixMethods.length > 0 && <span className="text-fg-muted"> · {r.fixMethods.map((m) => REMEDIATION_FIX_METHOD_LABELS[m] ?? m).join(', ')}</span>}
        </p>
      )}

      {r.stage === 'awaiting_approval' && r.proposeReasons.length > 0 && (
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

      {r.error && <p className="text-danger-strong" data-testid="remediation-error">Error: <span className="font-mono">{r.error}</span></p>}

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
        {canWrite && r.stage === 'awaiting_approval' && (
          <>
            <Button variant="success" size="xs" onClick={() => setPending('approve')}>
              <Check className="mr-1 h-3.5 w-3.5" aria-hidden />Approve and publish
            </Button>
            <Button variant="danger-outline" size="xs" onClick={() => setPending('reject')}>
              <X className="mr-1 h-3.5 w-3.5" aria-hidden />Reject
            </Button>
          </>
        )}
        {canWrite && RETRYABLE.has(r.stage) && (
          <Button variant="outline" size="xs" onClick={retry} loading={retryM.pending}>
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
          title={pending === 'approve' ? 'Approve and publish this fix?' : 'Reject this fix?'}
          action={pending === 'approve'
            ? `Publish ${r.pluginName} ${r.toVersion ?? ''} as the fix for ${r.fromVersion}`
            : `Reject the fix for ${r.pluginName} ${r.fromVersion}; the version stays flagged`}
          onConfirmed={(token) => decide(pending, token)}
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
