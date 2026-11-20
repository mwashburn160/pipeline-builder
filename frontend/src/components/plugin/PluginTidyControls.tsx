// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ToggleRow } from '@/components/ui/SettingRow';
import { useToast } from '@/components/ui/Toast';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { formatBytes } from '@/lib/format';
import type { TidyPreviewView, TidyVersionEntry } from '@/types/plugin-tidy';

const DAY = (iso?: string | null) => (iso ? iso.slice(0, 10) : '—');
const STALE_STATES = new Set(['warn', 'warn_queued', 'warned', 'deactivate', 'deactivated', 'retire']);

/** The versions of `name` tidying is acting on (stale, deactivated or due for deletion). */
export function staleVersionsOf(name: string, view: TidyPreviewView | null): TidyVersionEntry[] {
  return (view?.report?.versions ?? []).filter((v) => v.name === name && STALE_STATES.has(v.state));
}

/** "Stale" with the date tidying deactivates (or deactivated) it. */
export function StaleBadge({ entry }: { entry: TidyVersionEntry }) {
  const deactivated = entry.state === 'deactivated' || entry.state === 'retire';
  const label = deactivated
    ? `Stale — deactivated, deleted on ${DAY(entry.retireAt)}`
    : entry.deactivateAt ? `Stale — deactivated on ${DAY(entry.deactivateAt)}` : 'Stale';
  return <Badge color={deactivated ? 'red' : 'yellow'}>{label}</Badge>;
}

/**
 * Automatic tidying on the plugin page: each stale version with its "Stale"
 * badge and a Keep button, the plugin's "Never tidy" switch, and the bytes
 * tidying will free. Keep and Never tidy need `plugins:write` (`canKeep`).
 */
export function PluginTidyControls({ name, view, onChanged, readOnly = false }: {
  name: string;
  view: TidyPreviewView | null;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const keep = useMutation({
    fn: (id: string) => api.keepPluginVersion(id),
    errorFallback: 'Could not keep the version',
    onSuccess: () => { toast.success('Version kept: its clock restarted'); onChanged(); },
  });
  const never = useMutation({
    fn: (value: boolean) => api.setPluginNeverTidy(name, value),
    errorFallback: 'Could not change never tidy',
    onSuccess: () => onChanged(),
  });
  if (!view?.report || !view.settings || view.report.mode === 'off') return null;

  const stale = staleVersionsOf(name, view);
  const freed = stale.reduce((n, v) => n + (v.bytes ?? 0), 0);
  const canKeep = view.canKeep && !readOnly;
  const neverTidy = view.settings.neverTidy.includes(name);

  return (
    <div className="mt-2 space-y-1" data-testid="plugin-tidy">
      {stale.length > 0 && (
        <>
          <p className="text-xs text-fg-muted" data-testid="plugin-tidy-freed">
            Automatic tidying will free about {formatBytes(freed)} from {stale.length} stale version{stale.length === 1 ? '' : 's'}
            {view.report.mode === 'notify' ? ' if it is turned on' : ''}.
          </p>
          <ul className="space-y-1">
            {stale.map((v) => (
              <li key={v.pluginId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono">{v.version}</span>
                <StaleBadge entry={v} />
                {canKeep && (
                  <Button size="sm" variant="secondary" loading={keep.pending} onClick={() => { void keep.run(v.pluginId); }}>
                    Keep {v.version}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.canKeep && (
        <ToggleRow
          label="Never tidy"
          description="Automatic tidying never warns about, deactivates or deletes any version of this plugin."
          checked={neverTidy}
          disabled={readOnly || never.pending}
          onChange={(v) => { void never.run(v); }}
        />
      )}
    </div>
  );
}

/**
 * The digest's one-click Keep: `/dashboard/plugins?tidyKeep=<id>` lands here
 * and offers the Keep for that version (a GET link never changes anything by
 * itself). Shown to `plugins:write` holders only.
 */
export function TidyKeepBanner({ pluginId, canWrite, onDone }: { pluginId: string | undefined; canWrite: boolean; onDone: () => void }) {
  const toast = useToast();
  const keep = useMutation({
    fn: (id: string) => api.keepPluginVersion(id),
    errorFallback: 'Could not keep the version',
    onSuccess: (res) => {
      const p = res.data?.plugin;
      toast.success(p ? `Kept ${p.name}@${p.version}: its clock restarted` : 'Version kept');
      onDone();
    },
  });
  if (!pluginId || !canWrite) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-default bg-surface-muted p-3 text-sm" data-testid="tidy-keep-banner">
      <span>Keep the plugin version from the tidying digest? Its clock restarts and, if tidying deactivated it, it is active again.</span>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { void keep.run(pluginId); }} loading={keep.pending}>Keep this version</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Dismiss</Button>
      </div>
    </div>
  );
}
