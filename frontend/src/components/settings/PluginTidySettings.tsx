// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Disclosure } from '@/components/ui/Disclosure';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { formatBytes } from '@/lib/format';
import {
  AUTO_TIDY_MODE_LABELS, TIDY_SKIP_REASON_LABELS, TIDY_STALE_MIN_DAYS,
  type AutoTidyMode, type TidyPreviewView, type TidySettingsWrite, type TidyVersionEntry,
} from '@/types/plugin-tidy';

const MODES: AutoTidyMode[] = ['off', 'notify', 'on'];
const DAY = (iso?: string | null) => (iso ? iso.slice(0, 10) : '—');

/** What the next pass does with one version, in words. */
export function tidyStateLabel(v: TidyVersionEntry): string {
  switch (v.state) {
    case 'warn': return 'Warned in the next digest';
    case 'warn_queued': return `Warned in the digest of ${DAY(v.nextDigestAt)}`;
    case 'warned': return `Stale — deactivated on ${DAY(v.deactivateAt)}`;
    case 'deactivate': return 'Deactivated in the next pass';
    case 'deactivated': return `Deactivated — deleted on ${DAY(v.retireAt)}`;
    case 'retire': return 'Deleted in the next pass (restorable)';
    case 'reactivate': return 'Reactivated in the next pass';
    case 'clear': return 'Warning dropped in the next pass';
    case 'skipped': return `Kept: ${v.reason ? TIDY_SKIP_REASON_LABELS[v.reason] : 'protected'}`;
    default: return v.state;
  }
}

/** The body: ONLY the fields that changed, or null. */
export function tidySettingsChanges(saved: { autoTidy: AutoTidyMode; staleAfterDays: number }, draft: { autoTidy: AutoTidyMode; staleAfterDays: number }): TidySettingsWrite | null {
  const body: TidySettingsWrite = {};
  if (draft.autoTidy !== saved.autoTidy) body.autoTidy = draft.autoTidy;
  if (draft.staleAfterDays !== saved.staleAfterDays) body.staleAfterDays = draft.staleAfterDays;
  return Object.keys(body).length > 0 ? body : null;
}

/**
 * Settings → Organization → Plugin security → "Automatic tidying"
 * (`/plugins/tidy/*`): the org's mode (off / notify — the default — / on), how
 * many days without use make a version stale, and the dry run of today's pass
 * (what would be warned, deactivated or deleted, why each protected version is
 * kept, and the bytes it frees). Readable with `plugins:read`; the save needs
 * `org_settings:write` (`canEdit`).
 */
export function PluginTidySettings({ orgId, canEdit, readOnly }: { orgId: string; canEdit: boolean; readOnly: boolean }) {
  const toast = useToast();
  const [draft, setDraft] = useState<{ autoTidy: AutoTidyMode; staleAfterDays: number } | null>(null);

  const read = useFetch(async (signal) => (await api.getPluginTidyPreview({ signal })).data ?? null, [orgId]);
  const view: TidyPreviewView | null = read.data;
  useEffect(() => {
    if (view?.settings) setDraft({ autoTidy: view.settings.autoTidy, staleAfterDays: view.settings.staleAfterDays });
  }, [view]);

  const save = useMutation({
    fn: (body: TidySettingsWrite) => api.updatePluginTidySettings(body),
    scopeKey: orgId,
    errorFallback: 'Could not save the tidying settings',
    onSuccess: () => {
      toast.success('Tidying settings saved');
      void read.refetch();
    },
  });

  if (read.error && !view) return <RetryError message={formatError(read.error, 'Could not load the tidying settings')} onRetry={read.refetch} />;
  if (!view?.report || !draft) return <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>;

  const editable = canEdit && view.canEdit && !readOnly;
  const days = Number.isInteger(draft.staleAfterDays) ? draft.staleAfterDays : 0;
  const valid = days >= TIDY_STALE_MIN_DAYS;
  const changes = valid ? tidySettingsChanges(view.settings, draft) : null;
  const { report } = view;
  const acting = report.versions.filter((v) => v.state !== 'skipped');
  const kept = report.versions.filter((v) => v.state === 'skipped');

  return (
    <div className="space-y-4" data-testid="plugin-tidy-settings">
      <div>
        <h3 className="text-sm font-semibold text-fg">Automatic tidying</h3>
        <p className="text-xs text-fg-muted">
          Finds plugin versions nothing has used for a while. A weekly digest lists them with a Keep link each; when tidying is on,
          a stale version is deactivated a week after its warning (an exact pin still resolves it) and deleted 30 days later if still
          unused. The latest, default, in-use, frozen and only versions are never touched.
        </p>
      </div>

      {!report.operatorEnabled && <Callout variant="info">Automatic tidying is turned off on this instance by the operator. Your settings are kept; nothing runs.</Callout>}
      {save.error && <Callout variant="danger">{save.error}</Callout>}

      <FormField label="Mode" hint="Notify only sends the digest; nothing changes until you turn tidying on.">
        <Select value={draft.autoTidy} disabled={!editable} aria-label="Automatic tidying mode"
          onChange={(e) => setDraft({ ...draft, autoTidy: e.target.value as AutoTidyMode })}>
          {MODES.map((m) => <option key={m} value={m}>{AUTO_TIDY_MODE_LABELS[m]}</option>)}
        </Select>
      </FormField>

      <FormField label="Stale after (days without use)" hint={`A synth or a pipeline save resolving a version counts as use. At least ${TIDY_STALE_MIN_DAYS} days.`}>
        <Input type="number" min={TIDY_STALE_MIN_DAYS} value={String(draft.staleAfterDays)} disabled={!editable} aria-label="Stale after days"
          onChange={(e) => setDraft({ ...draft, staleAfterDays: Number.parseInt(e.target.value, 10) })} />
      </FormField>
      {!valid && <p className="text-xs text-danger-strong">Enter {TIDY_STALE_MIN_DAYS} days or more.</p>}

      <Disclosure title={`Preview: ${report.totals.warn + report.totals.warnQueued} to warn, ${report.totals.deactivate} to deactivate, ${report.totals.retire} to delete, ${kept.length} kept`}>
        <div className="space-y-3 text-sm" data-testid="plugin-tidy-preview">
          <p className="text-fg-muted">
            {report.totals.bytesFreed !== null
              ? <>Tidying these versions frees about <strong>{formatBytes(report.totals.bytesFreed)}</strong>.</>
              : 'The storage these versions use could not be measured just now.'}
            {report.mode === 'off' && ' Tidying is off, so nothing is planned.'}
          </p>
          {acting.length > 0 && (
            <ul className="space-y-1">
              {acting.map((v) => (
                <li key={v.pluginId} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{v.name}@{v.version}</span>
                  <Badge color={v.state === 'retire' || v.state === 'deactivated' ? 'red' : 'yellow'}>{tidyStateLabel(v)}</Badge>
                  <span className="text-xs text-fg-muted">stale since {DAY(v.staleAt)}{v.bytes ? ` · ${formatBytes(v.bytes)}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {kept.length > 0 && (
            <ul className="space-y-1" aria-label="Versions tidying keeps">
              {kept.map((v) => (
                <li key={v.pluginId} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{v.name}@{v.version}</span>
                  <Badge color="gray">{tidyStateLabel(v)}</Badge>
                </li>
              ))}
            </ul>
          )}
          {report.versions.length === 0 && <p className="text-fg-muted">Nothing is stale.</p>}
        </div>
      </Disclosure>

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => { if (changes) void save.run(changes); }} loading={save.pending} readOnly={readOnly} disabled={!changes}>
            Save tidying settings
          </Button>
        </div>
      )}
    </div>
  );
}
