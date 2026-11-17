// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { FileSearch } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { SectionCard } from '@/components/ui/SectionCard';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { useMutation } from '@/hooks/useMutation';
import { formatError } from '@/lib/constants';
import type { ArtifactSecurityReport, PipelineSecurityReports, SeverityCounts } from '@/lib/api/pipeline-security-types';

function Counts({ counts }: { counts: SeverityCounts }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums">
      {counts.kev > 0 && <span className="font-semibold text-danger-strong">{counts.kev} KEV</span>}
      <span className={counts.critical > 0 ? 'text-danger-strong' : 'text-fg-muted'}>{counts.critical} crit ({counts.criticalFixable} fixable)</span>
      <span className={counts.high > 0 ? 'text-warning-strong' : 'text-fg-muted'}>{counts.high} high ({counts.highFixable} fixable)</span>
      <span className="text-fg-muted">{counts.medium} med · {counts.low} low</span>
    </span>
  );
}

/**
 * What the pipeline's OWN scan steps found in what it builds: the latest report
 * per (tool, stage) a run uploaded, with summed counts. Informational — like
 * plugin findings, these never stop the pipeline; they feed its scorecard.
 */
export function ArtifactSecurityReportsCard({ pipelineId, canWrite }: { pipelineId: string; canWrite: boolean }) {
  const toast = useToast();
  const [removing, setRemoving] = useState<ArtifactSecurityReport | null>(null);
  const read = useFetch<PipelineSecurityReports>(async (signal) => {
    const res = await api.getPipelineSecurityReports(pipelineId, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load security reports');
    return res.data;
  }, [pipelineId]);
  const data = read.data;
  const lock = canWrite ? undefined : 'Requires pipelines:write';

  const removeM = useMutation({
    fn: async (report: ArtifactSecurityReport) => {
      const res = await api.deletePipelineSecurityReport(pipelineId, { tool: report.tool, stage: report.stage || undefined });
      if (!res.success) throw new Error(res.message || 'Failed to remove the report');
      return res;
    },
    scopeKey: pipelineId,
    errorFallback: 'Failed to remove the report',
    toast: { error: true },
    onSuccess: (_r, report) => {
      toast.success(`Removed the ${report.tool} report${report.stage ? ` for ${report.stage}` : ''}`);
      setRemoving(null);
      void read.refetch();
    },
    onStepUpResumed: () => { setRemoving(null); void read.refetch(); },
  });
  const busy = removeM.pending;

  const remove = async () => {
    if (!removing) return;
    await removeM.run(removing);
  };

  return (
    <SectionCard
      title="Artifact security reports"
      icon={FileSearch}
      description="The latest scanner report per tool and stage that this pipeline's runs uploaded."
    >
      {read.loading && !data && <LoadingSpinner />}
      {read.error && <RetryError message={formatError(read.error, 'Failed to load security reports')} onRetry={read.refetch} />}
      {data && data.reports.length === 0 && (
        <p className="text-sm text-fg-muted">
          No reports yet. A scan step in the pipeline uploads one with <code className="font-mono text-xs">POST /api/pipelines/{'{id}'}/security-reports</code>;
          until then the pipeline&apos;s own artifacts are unmeasured, not clean.
        </p>
      )}
      {data && data.reports.length > 0 && (
        <div className="space-y-3" data-testid="artifact-security-reports">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-fg-muted">Total across {data.reports.length} report{data.reports.length === 1 ? '' : 's'}</span>
            <Counts counts={data.counts} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Artifact security reports">
              <thead>
                <tr className="border-b border-default text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <th scope="col" className="py-2 pr-3 font-medium">Tool</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Stage</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Findings</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Uploaded</th>
                  <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.reports.map((r) => (
                  <tr key={r.id} className="border-b border-default align-top last:border-0">
                    <td className="py-2 pr-3">
                      <span className="font-medium text-fg">{r.tool}</span>
                      <span className="block text-2xs text-fg-subtle">{r.format}</span>
                    </td>
                    <td className="py-2 pr-3 text-fg-muted">{r.stage || '—'}</td>
                    <td className="py-2 pr-3">
                      <Counts counts={r.counts} />
                      {r.findings.length > 0 && (
                        <span className="mt-1 block font-mono text-2xs text-fg-subtle">
                          {r.findings.slice(0, 3).map((f) => f.id).join(', ')}{r.findings.length > 3 || r.truncated ? ', …' : ''}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-fg-muted"><RelativeTime value={r.createdAt} /></td>
                    <td className="py-2 text-right">
                      <Button variant="secondary" size="xs" disabled={!canWrite} title={lock}
                        aria-label={`Remove ${r.tool}${r.stage ? ` ${r.stage}` : ''} report`} onClick={() => setRemoving(r)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {removing && (
        <ConfirmDialog
          title="Remove this security report?"
          confirmLabel="Remove report"
          tone="danger"
          loading={busy}
          onConfirm={() => void remove()}
          onCancel={() => setRemoving(null)}
        >
          <p>
            The latest <span className="font-medium text-fg">{removing.tool}</span> report
            {removing.stage ? <> for stage <span className="font-medium text-fg">{removing.stage}</span></> : ' (no stage)'} stops
            counting toward this pipeline&apos;s security score and scorecard.
          </p>
          <p>Use it for a scanner the pipeline no longer runs or a stage it renamed — a run that still uploads to this slot recreates it.</p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
