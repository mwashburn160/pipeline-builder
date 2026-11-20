// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { PluginTidyControls } from '@/components/plugin/PluginTidyControls';
import type { TidyPreviewView } from '@/types/plugin-tidy';
import type { Plugin } from '@/types';
import type { StorageReclaimPlan } from '@/types/storage-reclaim';

/** One version's storage, as the section lists it. */
export interface VersionStorageRow {
  id: string;
  version: string;
  /** Kept build-source bytes; null when the version keeps none. */
  sourceBytes: number | null;
  /** A prebuilt-image upload: no source, overlay-only remediation. */
  sourceless: boolean;
  /** Bytes the version's image alone occupies (its own layers); null when the registry did not report it. */
  imageBytes: number | null;
}

type VersionFacts = Pick<Plugin, 'id' | 'name' | 'version'> & Partial<Pick<Plugin, 'sourceKind' | 'sourceSizeBytes'>>;

/** Join a name's versions with the registry's per-version marginal bytes. */
export function versionStorageRows(name: string, versions: readonly VersionFacts[], plan: StorageReclaimPlan | null): VersionStorageRow[] {
  const image = new Map<string, number>();
  for (const c of plan?.candidates ?? []) if (c.pluginName === name && c.version) image.set(c.version, c.marginalBytes);
  return versions
    .filter((v) => v.name === name)
    .map((v) => ({
      id: v.id,
      version: v.version,
      sourceBytes: v.sourceKind === 'zip' ? (v.sourceSizeBytes ?? null) : null,
      sourceless: v.sourceKind === 'none',
      imageBytes: image.has(v.version) ? image.get(v.version)! : null,
    }));
}

const STORAGE_FIELDS = 'id,orgId,name,version,sourceKind,sourceSizeBytes';

/**
 * Storage on the plugin page: kept source and image bytes per version, and what
 * purging them would free (the source plus the version's own image layers — a
 * layer another version shares is not freed). The image figures come from the
 * registry's reclaim plan; when it cannot be read the source figures still show.
 * The tidy controls' Keep and Never tidy follow `canWrite` as well as the
 * server's `canKeep` (which cannot see a read-only impersonation session).
 */
export function PluginStorageSection({ name, canWrite }: {
  name: string;
  /** `plugins:write` in a writable session (the page's `can('plugins:write')`): Keep and Never tidy. */
  canWrite: boolean;
}) {
  const { data: versions, loading } = useFetch<VersionFacts[]>(async () => {
    const res = await api.listPlugins({ name, fields: STORAGE_FIELDS, limit: '100' });
    return (res.data?.plugins ?? []) as VersionFacts[];
  }, [name]);
  const { data: plan } = useFetch<StorageReclaimPlan | null>(async () => {
    try {
      const res = await api.getStorageReclaim();
      return res.data ?? null;
    } catch {
      return null;
    }
  }, []);

  // Automatic tidying: the org's dry run, for this plugin's stale versions.
  const tidy = useFetch<TidyPreviewView | null>(async () => {
    try {
      const res = await api.getPluginTidyPreview();
      return res.data ?? null;
    } catch {
      return null;
    }
  }, []);

  const rows = versionStorageRows(name, versions ?? [], plan ?? null);
  const freed = rows.reduce((n, r) => n + (r.sourceBytes ?? 0) + (r.imageBytes ?? 0), 0);

  return (
    <div data-testid="plugin-storage">
      <p className="text-xs font-medium text-fg-muted mb-1">Storage</p>
      {loading && rows.length === 0 ? (
        <p role="status" className="text-xs text-fg-subtle">Loading storage…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-fg-subtle">No stored versions.</p>
      ) : (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-fg-muted">
                <th className="font-medium py-0.5">Version</th>
                <th className="font-medium py-0.5">Source</th>
                <th className="font-medium py-0.5">Image</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-0.5 font-mono">{r.version}</td>
                  <td className="py-0.5">
                    {r.sourceless ? <span className="text-fg-subtle">Prebuilt image, no kept source</span>
                      : r.sourceBytes != null ? formatBytes(r.sourceBytes) : '—'}
                  </td>
                  <td className="py-0.5">{r.imageBytes != null ? formatBytes(r.imageBytes) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-fg-muted" data-testid="plugin-storage-freed">
            Purging every version would free about {formatBytes(freed)}
            {plan == null || plan.incomplete ? ' (image sizes could not all be measured, so it may be more)' : ''}.
          </p>
        </>
      )}
      {tidy.data?.report && <PluginTidyControls name={name} view={tidy.data} readOnly={!canWrite} onChanged={() => { void tidy.refetch(); }} />}
    </div>
  );
}
