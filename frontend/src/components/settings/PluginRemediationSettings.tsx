// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import {
  GRYPE_PACKAGE_TYPES, LIBRARY_UPGRADE_LEVELS, PLUGIN_REMEDIATION_MODES, PLUGIN_REMEDIATION_ROLLOUTS, TEAM_REMEDIATION_ROLLOUTS,
  type GrypePackageType, type LibraryUpgradeLevel,
} from '@pipeline-builder/api-core/plugin-scan';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Disclosure } from '@/components/ui/Disclosure';
import { FormField } from '@/components/ui/FormField';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { Select } from '@/components/ui/Select';
import { ToggleRow } from '@/components/ui/SettingRow';
import { useToast } from '@/components/ui/Toast';
import { RemediationOffNotice } from '@/components/plugin/RemediationOffNotice';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import {
  LIBRARY_UPGRADE_LEVEL_LABELS, REMEDIATION_MODE_LABELS, REMEDIATION_ROLLOUT_LABELS, packageTypeLabel,
} from '@/lib/plugin-remediation';
import type {
  PluginRemediationSettings as Settings, PluginRemediationSettingsView, PluginRemediationSettingsWrite,
} from '@/types/plugin-remediation';

type Draft = Pick<Settings, 'mode' | 'libraryUpgradeLevel' | 'libraryUpgradeLevelByType' | 'rollout' | 'allowPipelineApply'>;

const draftOf = (s: Settings): Draft => ({
  mode: s.mode,
  libraryUpgradeLevel: s.libraryUpgradeLevel,
  libraryUpgradeLevelByType: { ...s.libraryUpgradeLevelByType },
  rollout: s.rollout,
  allowPipelineApply: s.allowPipelineApply,
});

/**
 * The write body: ONLY the fields that changed. A per-type override that was
 * removed is sent as `null` (clears it); one that was added or changed as its
 * level. Returns null when nothing changed.
 */
export function remediationSettingsChanges(saved: Settings, draft: Draft, isTeam: boolean): PluginRemediationSettingsWrite | null {
  const body: PluginRemediationSettingsWrite = {};
  if (draft.mode !== saved.mode) body.mode = draft.mode;
  if (draft.libraryUpgradeLevel !== saved.libraryUpgradeLevel) body.libraryUpgradeLevel = draft.libraryUpgradeLevel;
  if (draft.rollout !== saved.rollout) body.rollout = draft.rollout;
  if (!isTeam && draft.allowPipelineApply !== saved.allowPipelineApply) body.allowPipelineApply = draft.allowPipelineApply;
  const byType: Partial<Record<GrypePackageType, LibraryUpgradeLevel | null>> = {};
  for (const t of GRYPE_PACKAGE_TYPES) {
    const before = saved.libraryUpgradeLevelByType[t] ?? null;
    const after = draft.libraryUpgradeLevelByType[t] ?? null;
    if (before !== after) byType[t] = after;
  }
  if (Object.keys(byType).length > 0) body.libraryUpgradeLevelByType = byType;
  return Object.keys(body).length > 0 ? body : null;
}

/**
 * Settings → Organization → Plugin security → "Security fixes": the nightly
 * CVE remediation settings (`/plugins/remediation-settings`).
 *
 * Fix building (off / propose / apply), how far a library may move (with
 * per-package-type overrides; the strictest of org, type and plugin applies),
 * how fixes reach pipelines, and — on a root org — whether a pipeline may
 * elect Apply itself. A team's rollout can follow the root's; the root's
 * values are shown for it. Readable with `plugins:read`; `canEdit`
 * (`org_settings:write`) adds the save. While the operator knob is off the
 * settings stay editable and a notice says nothing runs.
 */
export function PluginRemediationSettings({ orgId, canEdit, readOnly }: {
  orgId: string;
  canEdit: boolean;
  readOnly: boolean;
}) {
  const toast = useToast();
  const [view, setView] = useState<PluginRemediationSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const apply = useCallback((v: PluginRemediationSettingsView) => {
    setView(v);
    setDraft(draftOf(v.settings));
  }, []);

  const read = useFetch(async (signal) => {
    const res = await api.getPluginRemediationSettings({ signal });
    return res.data ?? null;
  }, [orgId], {
    onSuccess: (v) => { if (v?.settings) apply(v); },
  });

  const save = useMutation({
    fn: (body: PluginRemediationSettingsWrite) => api.updatePluginRemediationSettings(body),
    scopeKey: orgId,
    errorFallback: 'Could not save the security fix settings',
    onSuccess: (res) => {
      // The PUT answers only `{ settings }`: keep the rest of the view (team, root, knob, severities).
      const saved = res.data?.settings;
      if (saved) {
        setView((v) => (v ? { ...v, settings: saved } : v));
        setDraft(draftOf(saved));
      }
      toast.success('Security fix settings saved');
    },
  });

  const editable = canEdit && (view?.canEdit ?? true) && !readOnly;
  const isTeam = !!view?.isTeam;
  const changes = view && draft ? remediationSettingsChanges(view.settings, draft, isTeam) : null;

  if (read.error && !view) {
    return <RetryError message={formatError(read.error, 'Could not load the security fix settings')} onRetry={read.refetch} />;
  }
  if (!view || !draft) {
    return <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>;
  }

  const rolloutOptions = isTeam ? TEAM_REMEDIATION_ROLLOUTS : PLUGIN_REMEDIATION_ROLLOUTS;
  const severities = view.severities.length > 0 ? view.severities : ['critical', 'high'];
  const allowApply = isTeam ? view.root?.allowPipelineApply ?? true : draft.allowPipelineApply;

  return (
    <div className="space-y-4" data-testid="plugin-remediation-settings">
      <div>
        <h3 className="text-sm font-semibold text-fg">Security fixes</h3>
        <p className="text-xs text-fg-muted">
          After each nightly rescan the platform rebuilds a flagged plugin version on a fresh base image and upgrades the
          named libraries, publishes the fix as the next patch version, and moves pipelines onto it. Targets fixable{' '}
          <span data-testid="remediation-severities">{severities.map((s) => (s === 'critical' ? 'Critical' : 'High')).join(' and ')}</span>{' '}
          findings; known exploited (KEV) findings are always targeted.
        </p>
      </div>

      {view.enabled === false && <RemediationOffNotice />}
      {save.error && <Callout variant="danger">{save.error}</Callout>}

      <FormField label="Fix building" hint="Major library upgrades, plugins without a smokeTest and ask-agent patches always wait for approval.">
        <Select value={draft.mode} disabled={!editable} aria-label="Fix building"
          onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}>
          {PLUGIN_REMEDIATION_MODES.map((m) => <option key={m} value={m}>{REMEDIATION_MODE_LABELS[m]}</option>)}
        </Select>
      </FormField>

      <FormField label="Library upgrade level" hint="How far a library may move from its installed version. A plugin can set a stricter level of its own.">
        <Select value={draft.libraryUpgradeLevel} disabled={!editable} aria-label="Library upgrade level"
          onChange={(e) => setDraft({ ...draft, libraryUpgradeLevel: e.target.value as LibraryUpgradeLevel })}>
          {LIBRARY_UPGRADE_LEVELS.map((l) => <option key={l} value={l}>{LIBRARY_UPGRADE_LEVEL_LABELS[l]}</option>)}
        </Select>
      </FormField>

      <Disclosure title={`Per package type (${Object.keys(draft.libraryUpgradeLevelByType).length} override${Object.keys(draft.libraryUpgradeLevelByType).length === 1 ? '' : 's'})`}>
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Upgrade level per package type">
          {GRYPE_PACKAGE_TYPES.map((t) => (
            <label key={t} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-fg">{packageTypeLabel(t)}</span>
              <Select
                aria-label={`Upgrade level for ${packageTypeLabel(t)}`}
                value={draft.libraryUpgradeLevelByType[t] ?? ''}
                disabled={!editable}
                onChange={(e) => {
                  const next = { ...draft.libraryUpgradeLevelByType };
                  if (e.target.value) next[t] = e.target.value as LibraryUpgradeLevel;
                  else delete next[t];
                  setDraft({ ...draft, libraryUpgradeLevelByType: next });
                }}
              >
                <option value="">Use organization level</option>
                {LIBRARY_UPGRADE_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </Select>
            </label>
          ))}
        </div>
      </Disclosure>

      <FormField
        label="Pipeline rollout"
        hint={isTeam && draft.rollout === 'inherit' && view.root
          ? `Following the root organization: ${REMEDIATION_ROLLOUT_LABELS[view.root.rollout]}.`
          : 'Each pipeline can follow this, opt out, or choose its own mode.'}
      >
        <Select value={draft.rollout} disabled={!editable} aria-label="Pipeline rollout"
          onChange={(e) => setDraft({ ...draft, rollout: e.target.value as Draft['rollout'] })}>
          {rolloutOptions.map((r) => <option key={r} value={r}>{REMEDIATION_ROLLOUT_LABELS[r]}</option>)}
        </Select>
      </FormField>

      {isTeam ? (
        <p className="text-sm text-fg-muted" data-testid="root-allow-apply">
          Pipelines may choose Apply themselves: {allowApply ? 'yes' : 'no'} (set by the root organization).
        </p>
      ) : (
        <div className="border-y border-default">
          <ToggleRow
            label="Pipelines may choose Apply"
            description="Lets a pipeline elect automatic upgrades when the organization default is Propose or Off. Opting out is always allowed."
            checked={draft.allowPipelineApply}
            disabled={!editable}
            onChange={(v) => setDraft({ ...draft, allowPipelineApply: v })}
          />
        </div>
      )}

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => { if (changes) void save.run(changes); }} loading={save.pending} readOnly={readOnly} disabled={!changes}>
            Save security fix settings
          </Button>
        </div>
      )}
    </div>
  );
}
