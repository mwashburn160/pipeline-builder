// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { FileSearch } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { PipelineSecurityReports, SeverityCounts } from '@/lib/api/pipeline-security-types';

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
export function ArtifactSecurityReportsCard({ pipelineId }: { pipelineId: string }) {
  const read = useFetch<PipelineSecurityReports>(async (signal) => {
    const res = await api.getPipelineSecurityReports(pipelineId, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load security reports');
    return res.data;
  }, [pipelineId]);
  const data = read.data;

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
                  <th scope="col" className="py-2 font-medium">Uploaded</th>
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
                    <td className="py-2 text-xs text-fg-muted"><RelativeTime value={r.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
