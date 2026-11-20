// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import { pipelineElectionAllowed, PIPELINE_REMEDIATION_ELECTIONS } from '@pipeline-builder/api-core/plugin-scan';
import { SectionCard } from '@/components/ui/SectionCard';
import { Badge, type BadgeColor } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { PIPELINE_ELECTION_LABELS, PIPELINE_UPGRADE_STATE_LABELS } from '@/lib/plugin-remediation';
import type {
  PipelineRemediationElection, PipelineRemediationUpgrades, PipelineRemediationUpgradeView,
} from '@/types/plugin-remediation';

const LOCK = 'Requires pipelines:write';

const STATE_COLORS: Record<string, BadgeColor> = {
  proposed: 'yellow', change_requested: 'yellow', queued: 'blue', moved: 'green', failed: 'red',
  rolled_back: 'red', rollback_blocked: 'red', skipped_opt_out: 'gray', skipped_runner: 'gray', dismissed: 'gray', superseded: 'gray',
};

const ORG_MODE_WORDS: Record<string, string> = { off: 'Off', propose: 'Propose', apply: 'Apply' };

/** "fixes 3 Critical CVEs" from what the rollout sent, else plain words. */
export function proposalFixText(u: PipelineRemediationUpgradeView): string {
  const parts: string[] = [];
  if (u.criticalCleared) parts.push(`${u.criticalCleared} Critical`);
  if (u.highCleared) parts.push(`${u.highCleared} High`);
  if (parts.length > 0) {
    const n = (u.criticalCleared ?? 0) + (u.highCleared ?? 0);
    return `fixes ${parts.join(' and ')} CVE${n === 1 ? '' : 's'}`;
  }
  if (u.advisoryIds && u.advisoryIds.length > 0) return `fixes ${u.advisoryIds.length} CVE${u.advisoryIds.length === 1 ? '' : 's'}`;
  return `fixes known vulnerabilities in ${u.fromVersion}`;
}

function UpgradeLine({ u }: { u: PipelineRemediationUpgradeView }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm text-fg">{u.pluginPublisher ? `${u.pluginPublisher}/` : ''}{u.pluginName}</span>
      <span className="font-mono text-xs text-fg-muted">{u.fromVersion} → {u.toVersion}</span>
      <Badge color={STATE_COLORS[u.state] ?? 'gray'}>{PIPELINE_UPGRADE_STATE_LABELS[u.state] ?? u.state}</Badge>
    </span>
  );
}

/**
 * The pipeline's side of nightly plugin CVE remediation (Stage 3): its Plugin
 * security fixes election, open upgrade proposals (Apply / Dismiss), the wave
 * status of an apply-mode rollout, and the rollback history. Opting out never
 * hides anything: the plugin security warnings above still show, and a
 * KEV-listed finding on an opted-out pipeline gets its own banner.
 */
export function RemediationUpgradesPanel({ pipelineId, canWrite, kevSteps = [], onChanged }: {
  pipelineId: string;
  canWrite: boolean;
  /** `plugin@version` of steps whose version carries a KEV-listed finding (from the security read). */
  kevSteps?: string[];
  onChanged?: () => void;
}) {
  const toast = useToast();
  const read = useFetch<PipelineRemediationUpgrades>(async (signal) => {
    const res = await api.getPipelineRemediationUpgrades(pipelineId, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load plugin security fixes');
    return res.data;
  }, [pipelineId]);
  const data = read.data;

  const [election, setElection] = useState<PipelineRemediationElection>('inherit');
  useEffect(() => { if (data) setElection(data.election); }, [data]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyAllowed = data ? pipelineElectionAllowed('apply', data.orgDefault, data.allowPipelineApply) : true;

  const saveM = useMutation({
    fn: async (value: PipelineRemediationElection) => {
      const res = await api.updatePipeline(pipelineId, { remediationUpgrades: value });
      if (!res.success) throw new Error(res.message || 'Failed to save');
      return res;
    },
    scopeKey: pipelineId,
    errorFallback: 'Failed to save',
    toast: { success: 'Plugin security fixes setting saved' },
    onSuccess: async () => {
      await read.refetch();
      onChanged?.();
    },
    onError: (err, message) => {
      setError(err instanceof ApiError && err.code === 'PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED'
        ? 'Your organization does not let pipelines choose Apply. Choose Propose or Off, or ask an admin to allow pipeline apply in Settings → Organization → Plugin security.'
        : message);
    },
  });
  const saving = saveM.pending;
  const save = () => {
    setError(null);
    void saveM.run(election);
  };

  const act = async (u: PipelineRemediationUpgradeView, kind: 'apply' | 'dismiss') => {
    setBusy(`${kind}:${u.id}`);
    setError(null);
    try {
      const res = kind === 'apply'
        ? await api.applyPipelineRemediationUpgrade(pipelineId, u.id)
        : await api.dismissPipelineRemediationUpgrade(pipelineId, u.id);
      if (!res.success) throw new Error(res.message || `Failed to ${kind} the upgrade`);
      toast.success(kind === 'apply' ? `Moved ${u.pluginName} to ${u.toVersion}` : 'Proposal dismissed');
      await read.refetch();
      onChanged?.();
    } catch (err) {
      setError(formatError(err, `Failed to ${kind} the upgrade`));
    } finally {
      setBusy(null);
    }
  };

  const upgrades = data?.upgrades ?? [];
  const proposals = upgrades.filter((u) => u.state === 'proposed');
  const changeRequests = upgrades.filter((u) => u.state === 'change_requested');
  const waves = upgrades.filter((u) => u.state === 'queued' || u.state === 'moved' || u.state === 'skipped_runner');
  const history = upgrades.filter((u) => u.state === 'rolled_back' || u.state === 'rollback_blocked' || u.state === 'failed');
  const skippedRunner = upgrades.filter((u) => u.state === 'skipped_runner').length;

  const optedOut = data?.effective.mode === 'off' && data.effective.source === 'pipeline';
  const kevUnused = upgrades.filter((u) => u.state === 'skipped_opt_out' || (u.kev === true && optedOut));
  const showKevBanner = optedOut && (kevSteps.length > 0 || kevUnused.length > 0);

  return (
    <SectionCard
      title="Plugin security fixes"
      icon={Wrench}
      description="When the platform publishes a fixed version of a plugin this pipeline uses, whether it is proposed here or applied automatically in waves."
    >
      {read.loading && !data && <LoadingSpinner />}
      {read.error && <RetryError message={formatError(read.error, 'Failed to load plugin security fixes')} onRetry={read.refetch} />}
      {data && (
        <div className="space-y-4" data-testid="remediation-upgrades">
          {showKevBanner && (
            <Callout variant="danger" title="Known exploited vulnerability, and this pipeline opted out of fixes">
              <span data-testid="kev-opt-out-banner">
                This pipeline is set to Off for plugin security fixes, so it is not moved to fixed versions.
                {kevSteps.length > 0 && <> {kevSteps.join(', ')} {kevSteps.length === 1 ? 'has' : 'have'} a CISA KEV-listed finding.</>}
                {kevUnused.length > 0 && (
                  <> Fixed version{kevUnused.length === 1 ? '' : 's'} not used: {kevUnused.map((u) => `${u.pluginName} ${u.toVersion}`).join(', ')}.</>
                )}
              </span>
            </Callout>
          )}

          <div className="space-y-2">
            <label htmlFor={`remediation-election-${pipelineId}`} className="block text-sm font-medium text-fg">Plugin security fixes</label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                id={`remediation-election-${pipelineId}`}
                className="w-auto"
                value={election}
                disabled={!canWrite || saving}
                title={canWrite ? undefined : LOCK}
                onChange={(e) => setElection(e.target.value as PipelineRemediationElection)}
              >
                {PIPELINE_REMEDIATION_ELECTIONS.map((v) => (
                  <option key={v} value={v} disabled={v === 'apply' && !applyAllowed && data.election !== 'apply'}>
                    {v === 'inherit'
                      ? `${PIPELINE_ELECTION_LABELS.inherit} (${ORG_MODE_WORDS[data.orgDefault] ?? data.orgDefault})`
                      : v === 'apply' && !applyAllowed ? `${PIPELINE_ELECTION_LABELS.apply} (not allowed by your organization)` : PIPELINE_ELECTION_LABELS[v]}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                className="text-xs"
                disabled={!canWrite || saving || election === data.election || (election === 'apply' && !applyAllowed)}
                title={canWrite ? undefined : LOCK}
                onClick={() => { void save(); }}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-fg-muted" data-testid="remediation-org-default">
              Organization default: {ORG_MODE_WORDS[data.orgDefault] ?? data.orgDefault}
              {data.effective.source === 'team' ? ' (set by this team)' : data.effective.source === 'root' ? ' (set by the organization)' : ''}.
              {' '}This pipeline: {ORG_MODE_WORDS[data.effective.mode] ?? data.effective.mode}.
              {!applyAllowed && ' Your organization does not let pipelines choose Apply.'}
            </p>
            {data.effective.applyRefused && (
              <p className="text-xs text-warning-strong" data-testid="remediation-apply-refused">
                This pipeline chose Apply, but the organization no longer allows it, so fixes are proposed instead.
              </p>
            )}
          </div>

          {error && <Callout variant="danger">{error}</Callout>}

          {proposals.map((u) => (
            <Callout key={u.id} variant="warning" title={`Plugin ${u.pluginName} ${u.toVersion} ${proposalFixText(u)}`}>
              <div className="space-y-2" data-testid={`remediation-proposal-${u.id}`}>
                <p className="text-xs">
                  This pipeline uses {u.pluginName} {u.fromVersion}. Applying moves it to {u.toVersion} through the normal validated upgrade and redeploys it.
                  {u.kev ? ' Includes a known exploited vulnerability.' : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button className="text-xs" disabled={!canWrite || busy !== null} title={canWrite ? undefined : LOCK} onClick={() => { void act(u, 'apply'); }}>
                    Apply
                  </Button>
                  <Button variant="secondary" className="text-xs" disabled={!canWrite || busy !== null} title={canWrite ? undefined : LOCK} onClick={() => { void act(u, 'dismiss'); }}>
                    Dismiss
                  </Button>
                </div>
              </div>
            </Callout>
          ))}

          {changeRequests.map((u) => (
            <Callout key={u.id} variant="info" title={`Change request opened for ${u.pluginName} ${u.toVersion}`}>
              <span data-testid={`remediation-change-request-${u.id}`}>
                This plugin comes from an approval-gated install, so an installer with plugin_installs:manage approves the move instead of it happening automatically.
              </span>
            </Callout>
          ))}

          {waves.length > 0 && (
            <div className="space-y-1" data-testid="remediation-waves">
              <h4 className="text-sm font-medium text-fg">Rollout</h4>
              <ul className="space-y-1">
                {waves.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <UpgradeLine u={u} />
                    {u.wave != null && <span>{u.wave === 0 ? 'Canary wave' : `Batch ${u.wave}`}</span>}
                    {u.movedAt && <span>moved <RelativeTime value={u.movedAt} /></span>}
                  </li>
                ))}
              </ul>
              {skippedRunner > 0 && (
                <p className="text-xs text-warning-strong">
                  Skipped {skippedRunner} time{skippedRunner === 1 ? '' : 's'} because the runner was unhealthy; retried in a later wave.
                </p>
              )}
            </div>
          )}

          {history.length > 0 && (
            <div className="space-y-1" data-testid="remediation-rollbacks">
              <h4 className="text-sm font-medium text-fg">Rollback history</h4>
              <ul className="space-y-1">
                {history.map((u) => (
                  <li key={u.id} className="space-y-0.5 text-xs text-fg-muted">
                    <UpgradeLine u={u} />
                    {u.state === 'rolled_back' && (
                      <span className="block">
                        A run failed on a step using {u.toVersion}, so it was moved back to {u.rolledBackTo ?? u.fromVersion}
                        {u.rolledBackAt && <> <RelativeTime value={u.rolledBackAt} /></>}.
                      </span>
                    )}
                    {u.state === 'rollback_blocked' && (
                      <span className="block text-danger-strong">
                        A rollback was needed, but {u.fromVersion} is no longer live (or carries a KEV-listed Critical without a risk acceptance). Choose a live version.
                      </span>
                    )}
                    {u.state === 'failed' && u.error && <span className="block text-danger-strong">Move failed: {u.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {upgrades.length === 0 && (
            <p className="text-sm text-fg-muted">No plugin security fixes have been proposed or applied for this pipeline.</p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
