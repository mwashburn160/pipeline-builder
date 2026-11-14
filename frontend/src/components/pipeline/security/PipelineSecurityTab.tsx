// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ShieldCheck, ShieldQuestion } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Badge, type BadgeColor } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { VulnSeverityBadge, VulnWarningList } from '@/components/plugin/VulnSeverity';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type {
  ExposureTriageBody, PipelineBuildImage, PipelineExposureView, PipelineSecurity, PipelineSecurityStep, StepScanFacts,
} from '@/lib/api/pipeline-security-types';
import { RESOLVED_VIA_LABELS, exposureHasKev } from '@/lib/pipeline-security';
import { shortDigest } from '@/lib/format';
import { ExposureTriageModal } from './ExposureTriageModal';
import { PluginUpgradePanel } from './PluginUpgradePanel';
import { ArtifactSecurityReportsCard } from './ArtifactSecurityReportsCard';

const TRIAGE_BADGE: Record<string, { color: BadgeColor; label: string }> = {
  open: { color: 'red', label: 'Open' },
  accepted: { color: 'yellow', label: 'Accepted' },
  false_positive: { color: 'gray', label: 'False positive' },
};

function ScanFacts({ step }: { step: { scan: StepScanFacts | null } }) {
  const s = step.scan;
  if (!s) return <span className="text-fg-subtle">—</span>;
  if (s.unscanned) return <span className="text-warning-strong">Never scanned</span>;
  return (
    <span className="space-y-0.5 text-xs tabular-nums">
      {s.kev > 0 && <span className="block font-semibold text-danger-strong">{s.kev} KEV</span>}
      {s.flagged && <span className="block text-danger-strong">Flagged by rescan</span>}
      <span className="block text-fg-muted">
        Crit {s.criticalFixable ?? '?'}/{s.critical ?? '?'} · High {s.highFixable ?? '?'}/{s.high ?? '?'} <span className="text-fg-subtle">(fixable/total)</span>
      </span>
      {s.scannedAt && (
        <span className={`block ${s.stale ? 'text-warning-strong' : 'text-fg-subtle'}`}>
          {s.stale ? 'Stale scan, ' : 'Scanned '}<RelativeTime value={s.scannedAt} />
        </span>
      )}
    </span>
  );
}

function StepsTable({ steps }: { steps: PipelineSecurityStep[] }) {
  if (steps.length === 0) {
    return <p className="text-sm text-fg-muted">No plugin steps recorded yet. Steps appear once the pipeline is saved or synthesized.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Plugin steps">
        <thead>
          <tr className="border-b border-default text-left text-xs uppercase tracking-wide text-fg-subtle">
            <th scope="col" className="py-2 pr-3 font-medium">Step</th>
            <th scope="col" className="py-2 pr-3 font-medium">Plugin</th>
            <th scope="col" className="py-2 pr-3 font-medium">Digest</th>
            <th scope="col" className="py-2 pr-3 font-medium">Severity</th>
            <th scope="col" className="py-2 pr-3 font-medium">Scan</th>
            <th scope="col" className="py-2 pr-3 font-medium">Warnings</th>
            <th scope="col" className="py-2 font-medium">Last lookup</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.stepKey} className="border-b border-default align-top last:border-0" data-testid={`security-step-${s.stepKey}`}>
              <td className="py-2 pr-3 font-mono text-xs">{s.stepKey}</td>
              <td className="py-2 pr-3 font-mono text-xs">
                {s.plugin ?? '—'}{s.version ? `@${s.version}` : ''}
                {s.declaredVersion && s.declaredVersion !== s.version && <span className="block font-sans text-2xs text-fg-subtle">declared {s.declaredVersion}</span>}
                {s.catalogState && s.catalogState !== 'live' && <span className="block font-sans text-2xs text-warning-strong">{s.catalogState}</span>}
              </td>
              <td className="py-2 pr-3 font-mono text-xs" title={s.digest ?? undefined}>{shortDigest(s.digest)}</td>
              <td className="py-2 pr-3"><VulnSeverityBadge grade={s.severity} /></td>
              <td className="py-2 pr-3"><ScanFacts step={s} /></td>
              <td className="py-2 pr-3 min-w-[16rem]">
                {s.currentWarnings.length > 0
                  ? <VulnWarningList warnings={s.currentWarnings} label={`Warnings for ${s.stepKey}`} itemTestId={(w) => `step-warning-${w.code.toLowerCase()}`} />
                  : <span className="text-xs text-fg-subtle">None</span>}
              </td>
              <td className="py-2 text-xs text-fg-muted">{s.lastLookupAt ? <RelativeTime value={s.lastLookupAt} /> : 'Never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The pipeline's build image — the toolchain release its default CodeBuild
 * image comes from. Not a step: one row with the release, how it was chosen,
 * its scan state and warnings, and whether it is behind the org's EFFECTIVE
 * default (org default, else platform default) or the synth isn't managed.
 */
function BuildImageRow({ image }: { image: PipelineBuildImage }) {
  const warnings = [
    ...image.warnings.map((w) => ({ code: w.code, severity: w.severity ?? 'warning', message: w.message })),
    ...image.currentWarnings,
  ];
  return (
    <div className="mb-4 rounded-lg border border-default p-3" data-testid="security-build-image">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">Build image</span>
        <span className="font-mono text-xs text-fg">{image.plugin}{image.releaseVersion ? `@${image.releaseVersion}` : ''}</span>
        <span className="font-mono text-xs text-fg-muted" title={image.digest ?? undefined}>{shortDigest(image.digest)}</span>
        <VulnSeverityBadge grade={image.severity} />
        {image.resolvedVia && <Badge color="gray">{RESOLVED_VIA_LABELS[image.resolvedVia] ?? image.resolvedVia}</Badge>}
        {image.behindDefault && image.effectiveDefault && (
          <span data-testid="build-image-behind"><Badge color="yellow">Behind default ({image.effectiveDefault.releaseVersion})</Badge></span>
        )}
        {image.toolchainUnmanaged && (
          <span data-testid="build-image-unmanaged"><Badge color="yellow">Toolchain unmanaged</Badge></span>
        )}
        {image.catalogState && image.catalogState !== 'live' && <Badge color="yellow">{image.catalogState}</Badge>}
      </div>
      {image.toolchainUnmanaged && (
        <p className="mt-1 text-xs text-fg-muted">
          The synth step runs <span className="font-mono">{image.synthPlugin}</span>, not the managed cdk-synth, so only the build image follows toolchain releases.
        </p>
      )}
      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
        <div><span className="block text-fg-subtle">Scan</span><ScanFacts step={image} /></div>
        <div className="sm:col-span-2">
          <span className="block text-fg-subtle">Warnings</span>
          {warnings.length > 0
            ? <VulnWarningList warnings={warnings} label="Warnings for the build image" itemTestId={(w) => `build-image-warning-${w.code.toLowerCase()}`} />
            : <span className="text-fg-subtle">None</span>}
        </div>
      </div>
      {image.change && (
        <p className="mt-2 text-xs text-fg-muted" data-testid="build-image-change">
          Toolchain {image.change.from} → {image.change.to}, <RelativeTime value={image.change.changedAt} />
        </p>
      )}
      {image.releaseNotes && <p className="mt-1 whitespace-pre-line text-xs text-fg-muted">{image.releaseNotes}</p>}
    </div>
  );
}

function ExposureRow({ exposure, canWrite, onTriage }: {
  exposure: PipelineExposureView;
  canWrite: boolean;
  onTriage: (action: ExposureTriageBody['action']) => void;
}) {
  const badge = TRIAGE_BADGE[exposure.triageState] ?? { color: 'gray' as BadgeColor, label: exposure.triageState };
  const closed = !!exposure.fixedAt;
  const lock = canWrite ? undefined : 'Requires pipelines:write';
  const kev = exposure.topFindings.filter((f) => f.kev === true).length;
  return (
    <li className="space-y-2 rounded-lg border border-default p-3" data-testid={`exposure-${exposure.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-fg">{exposure.plugin}@{exposure.version}</span>
        <Badge color={closed ? 'green' : badge.color}>{closed ? 'Fixed' : badge.label}</Badge>
        <Badge color="gray">{exposure.source}</Badge>
        {kev > 0 && <Badge color="red" className="font-bold">{kev} KEV</Badge>}
        <span className="text-xs text-fg-muted">{exposure.criticalCount} Critical · {exposure.highCount} High</span>
        <span className="text-xs text-fg-subtle">flagged <RelativeTime value={exposure.flaggedAt} /></span>
      </div>
      {exposure.topFindings.length > 0 && (
        <p className="font-mono text-2xs text-fg-muted">
          {exposure.topFindings.slice(0, 4).map((f) => String(f.id ?? '')).filter(Boolean).join(', ')}
          {exposure.findingCount > 4 ? `, … (${exposure.findingCount})` : ''}
        </p>
      )}
      {exposure.acceptance && (
        <p className="text-xs text-fg-muted">
          {exposure.acceptance.active ? 'Accepted' : 'Acceptance lapsed'}
          {exposure.acceptance.until && <> until <RelativeTime value={exposure.acceptance.until} /></>}
          {` · ${exposure.acceptance.findingCount} finding${exposure.acceptance.findingCount === 1 ? '' : 's'}`}
          {exposure.acceptance.kev ? ' · including KEV' : ''}
        </p>
      )}
      {exposure.triageReason && <p className="text-xs text-fg-muted">“{exposure.triageReason}”</p>}
      {!closed && (
        <div className="flex flex-wrap gap-2">
          {exposure.triageState !== 'accepted' && (
            <Button variant="secondary" className="text-xs" disabled={!canWrite} title={lock} onClick={() => onTriage('accept')}>Accept risk</Button>
          )}
          {exposure.triageState !== 'false_positive' && (
            <Button variant="secondary" className="text-xs" disabled={!canWrite} title={lock} onClick={() => onTriage('false_positive')}>False positive</Button>
          )}
          {exposure.triageState !== 'open' && (
            <Button variant="secondary" className="text-xs" disabled={!canWrite} title={lock} onClick={() => onTriage('reopen')}>Reopen</Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A pipeline's Plugin security tab: the overall severity, per step what it
 * resolves to and how that version grades now, the exposures with their triage
 * (accept with reason + expiry, false positive, reopen), the upgrade panel, and
 * the pipeline's own artifact scan reports. Vulnerabilities never stop the
 * pipeline — everything here is a grade, a notice or a remediation.
 */
export function PipelineSecurityTab({ pipelineId, canWrite }: { pipelineId: string; canWrite: boolean }) {
  const read = useFetch<PipelineSecurity>(async (signal) => {
    const res = await api.getPipelineSecurity(pipelineId, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load plugin security');
    return res.data;
  }, [pipelineId]);
  const data = read.data;

  // Closed (fixed / removed) exposures come from the exposures list on request.
  const [includeFixed, setIncludeFixed] = useState(false);
  const fixedRead = useFetch<PipelineExposureView[]>(async (signal) => {
    const res = await api.listPipelineExposures(pipelineId, { includeFixed: true }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load exposures');
    return res.data.exposures;
  }, [pipelineId, includeFixed], { enabled: includeFixed });
  const exposures = includeFixed ? (fixedRead.data ?? data?.exposures ?? []) : (data?.exposures ?? []);

  const [triage, setTriage] = useState<{ exposure: PipelineExposureView; action: ExposureTriageBody['action'] } | null>(null);

  const reload = () => { void read.refetch(); if (includeFixed) void fixedRead.refetch(); };

  return (
    <div className="space-y-4" data-testid="pipeline-security-tab">
      <SectionCard
        title="Plugin security"
        icon={data?.severity === 'ok' ? ShieldCheck : ShieldQuestion}
        description="How the plugin versions this pipeline uses grade right now. Vulnerabilities never stop the pipeline; they raise graded warnings and notify its owners."
        actions={data ? <VulnSeverityBadge grade={data.severity} /> : undefined}
      >
        {read.loading && !data && <LoadingSpinner />}
        {read.error && <RetryError message={formatError(read.error, 'Failed to load plugin security')} onRetry={read.refetch} />}
        {data?.buildImage && <BuildImageRow image={data.buildImage} />}
        {data && <StepsTable steps={data.steps} />}
      </SectionCard>

      {data && (
        <SectionCard
          title="Exposures"
          description="Vulnerable plugin versions this pipeline declares or runs. Triage applies to this pipeline only."
          actions={(
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <Checkbox checked={includeFixed} aria-label="Show fixed exposures" onChange={(e) => setIncludeFixed(e.target.checked)} />
              Show fixed
            </label>
          )}
        >
          {fixedRead.error && includeFixed && <RetryError message={formatError(fixedRead.error, 'Failed to load exposures')} onRetry={fixedRead.refetch} />}
          {exposures.length === 0 ? (
            <p className="text-sm text-fg-muted">No exposures. None of this pipeline&apos;s plugin versions has open findings.</p>
          ) : (
            <ul className="space-y-2" aria-label="Exposures">
              {exposures.map((e) => (
                <ExposureRow key={e.id} exposure={e} canWrite={canWrite} onTriage={(action) => setTriage({ exposure: e, action })} />
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      <PluginUpgradePanel pipelineId={pipelineId} canWrite={canWrite} onApplied={reload} />
      <ArtifactSecurityReportsCard pipelineId={pipelineId} />

      {triage && (
        <ExposureTriageModal
          pipelineId={pipelineId}
          exposure={triage.exposure}
          action={triage.action}
          needsKev={exposureHasKev(triage.exposure, data)}
          onClose={() => setTriage(null)}
          onDone={() => { setTriage(null); reload(); }}
        />
      )}
    </div>
  );
}
