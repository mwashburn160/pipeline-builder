// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpCircle } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { LoadingSpinner } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import { VulnWarningList } from '@/components/plugin/VulnSeverity';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type {
  PluginUpgradeApplyResult, PluginUpgradePreview, StepUpgrade, VersionRelease,
} from '@/lib/api/pipeline-security-types';

/** The version apply would write for a step (null = nothing it may write). */
export function upgradeTarget(u: StepUpgrade, widen: boolean): string | null {
  return widen ? u.apply.widenVersion : u.apply.version;
}

function reasonText(u: StepUpgrade): string {
  const r = u.reason;
  const parts: string[] = [];
  if (r.kev > 0) parts.push(`${r.kev} KEV`);
  if (r.flagged) parts.push('flagged by rescan');
  if (r.criticalFixable > 0) parts.push(`${r.criticalFixable} fixable Critical`);
  if (r.highFixable > 0) parts.push(`${r.highFixable} fixable High`);
  return parts.join(' · ') || 'newer clean version';
}

function ReleasesList({ releases }: { releases: VersionRelease[] }) {
  if (releases.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="upgrade-releases">
      <h4 className="text-sm font-medium text-fg">Versions this frees</h4>
      <p className="text-xs text-fg-muted">
        A plugin version any pipeline references can&apos;t be deleted. Once nothing declares or runs it, it becomes removable
        (a deployed reference clears when the pipeline is redeployed).
      </p>
      <ul className="space-y-1 text-sm">
        {releases.map((r) => (
          <li key={`${r.plugin}@${r.version}`} className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{r.plugin}@{r.version}</span>
            {r.removable
              ? <Badge color="green">Removable</Badge>
              : <Badge color="gray">Still referenced: {r.references.declared} declared · {r.references.deployed} deployed</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Move this pipeline's vulnerable plugin steps to newer versions: preview
 * (writes nothing) → choose steps, whether to widen past the pin and whether
 * to redeploy → apply through the normal validated write path. Shows which
 * versions the move frees for deletion. Apply needs `pipelines:write` and is
 * shown disabled, with the reason, without it.
 */
export function PluginUpgradePanel({ pipelineId, canWrite, onApplied }: {
  pipelineId: string;
  canWrite: boolean;
  onApplied?: () => void;
}) {
  const toast = useToast();
  const [widen, setWiden] = useState(false);
  const [redeploy, setRedeploy] = useState(false);
  const [preview, setPreview] = useState<PluginUpgradePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PluginUpgradeApplyResult | null>(null);

  const load = async (w: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.previewPluginUpgrades(pipelineId, { widen: w });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to preview upgrades');
      setPreview(res.data);
      setSelected(new Set(res.data.upgrades.filter((u) => upgradeTarget(u, w) !== null).map((u) => u.stepKey)));
    } catch (err) {
      setError(formatError(err, 'Failed to preview upgrades'));
    } finally {
      setLoading(false);
    }
  };

  // A different pipeline (same-pathname navigation) starts from scratch.
  useEffect(() => { setPreview(null); setResult(null); setError(null); }, [pipelineId]);

  const toggle = (key: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const apply = async () => {
    if (!preview || selected.size === 0) return;
    setApplying(true);
    setError(null);
    try {
      const res = await api.applyPluginUpgrades({ pipelineIds: [pipelineId], widen, steps: [...selected], redeploy });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to apply upgrades');
      setResult(res.data);
      const outcome = res.data.results[0];
      if (outcome?.status === 'failed') setError(outcome.error);
      else if (outcome?.status === 'upgraded') toast.success(`Upgraded ${outcome.applied.length} step${outcome.applied.length === 1 ? '' : 's'}`);
      else toast.info('Nothing to upgrade');
      setPreview(null);
      onApplied?.();
    } catch (err) {
      setError(formatError(err, 'Failed to apply upgrades'));
    } finally {
      setApplying(false);
    }
  };

  const upgradable = preview?.upgrades.filter((u) => upgradeTarget(u, widen) !== null) ?? [];
  const outcome = result?.results[0];

  return (
    <SectionCard
      title="Upgrade plugins"
      icon={ArrowUpCircle}
      description="Move steps off vulnerable plugin versions. Preview first; nothing changes until you apply."
      actions={(
        <Button variant="secondary" onClick={() => void load(widen)} disabled={loading}>
          {loading ? <LoadingSpinner size="sm" /> : null}
          {preview ? 'Refresh preview' : 'Preview upgrades'}
        </Button>
      )}
    >
      <div className="space-y-4" data-testid="plugin-upgrade-panel">
        <label className="flex items-start gap-2 text-sm text-fg">
          <Checkbox
            checked={widen}
            aria-label="Widen past the pin"
            onChange={(e) => { setWiden(e.target.checked); if (preview) void load(e.target.checked); }}
          />
          <span>
            Widen past the pin
            <span className="block text-xs text-fg-muted">Re-anchor a range, or cross an exact pin, when nothing inside it is clean.</span>
          </span>
        </label>

        {error && <Callout variant="danger">{error}</Callout>}

        {preview && preview.upgrades.length === 0 && (
          <p className="text-sm text-fg-muted" data-testid="upgrade-none">No step needs an upgrade.</p>
        )}

        {preview && preview.upgrades.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Proposed plugin upgrades">
              <thead>
                <tr className="border-b border-default text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <th scope="col" className="py-2 pr-3 font-medium"><span className="sr-only">Include</span></th>
                  <th scope="col" className="py-2 pr-3 font-medium">Step</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Plugin</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Now</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Move to</th>
                  <th scope="col" className="py-2 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {preview.upgrades.map((u) => {
                  const target = upgradeTarget(u, widen);
                  return (
                    <tr key={u.stepKey} className="border-b border-default last:border-0">
                      <td className="py-2 pr-3">
                        <Checkbox
                          aria-label={`Upgrade ${u.stepKey}`}
                          checked={selected.has(u.stepKey)}
                          disabled={target === null}
                          onChange={() => toggle(u.stepKey)}
                        />
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{u.stepKey}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{u.plugin}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {u.currentVersion}
                        {u.declaredVersion && u.declaredVersion !== u.currentVersion && <span className="text-fg-subtle"> ({u.declaredVersion})</span>}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {target ?? (
                          <span className="font-sans text-fg-subtle">
                            {!widen && u.apply.widenVersion ? `only by widening (${u.apply.widenVersion})` : 'no clean version'}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-xs text-fg-muted">{reasonText(u)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {preview && <ReleasesList releases={preview.releases} />}

        {preview && upgradable.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-3">
            <label className="flex items-center gap-2 text-sm text-fg">
              <Checkbox checked={redeploy} aria-label="Redeploy after upgrading" onChange={(e) => setRedeploy(e.target.checked)} />
              Redeploy after upgrading (starts an execution so the new versions run)
            </label>
            <Button
              onClick={() => void apply()}
              disabled={!canWrite || applying || selected.size === 0}
              title={canWrite ? undefined : 'Requires pipelines:write'}
            >
              {applying ? <LoadingSpinner size="sm" /> : null}
              Apply {selected.size} upgrade{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        )}

        {result && outcome && (
          <div className="space-y-3 border-t border-default pt-3" data-testid="upgrade-result">
            {outcome.status === 'upgraded' && (
              <>
                <ul className="space-y-1 text-sm">
                  {outcome.applied.map((a) => (
                    <li key={a.stepKey}>
                      <span className="font-mono text-xs">{a.stepKey}</span>: <span className="font-mono">{a.plugin}</span>{' '}
                      {a.fromDeclared ?? a.fromVersion} → <span className="font-mono">{a.toDeclared}</span>
                    </li>
                  ))}
                </ul>
                {outcome.pluginWarnings && outcome.pluginWarnings.length > 0 && (
                  <VulnWarningList warnings={outcome.pluginWarnings} showStep label="Plugin warnings after the upgrade" />
                )}
                {outcome.redeploy && 'executionId' in outcome.redeploy && (
                  <p className="text-sm text-fg-muted">Redeploy started (execution <span className="font-mono">{outcome.redeploy.executionId}</span>).</p>
                )}
                {outcome.redeploy && 'error' in outcome.redeploy && (
                  <Callout variant="warning">The upgrade was saved, but the redeploy could not start: {outcome.redeploy.error}</Callout>
                )}
              </>
            )}
            {outcome.status === 'unchanged' && <p className="text-sm text-fg-muted">Nothing changed — the pipeline already runs the suggested versions.</p>}
            {result.redeployRequired && (
              <Callout variant="info">
                Saved. Nothing runs the new versions until the pipeline is redeployed — re-run it from the{' '}
                <Link href={`/dashboard/pipelines/${pipelineId}?tab=runs`} className="action-link">Runs tab</Link>.
              </Callout>
            )}
            <ReleasesList releases={result.releases} />
          </div>
        )}
      </div>
    </SectionCard>
  );
}
