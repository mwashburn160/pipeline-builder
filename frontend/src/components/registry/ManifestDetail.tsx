// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { RegistryManifestKind, RegistryPlatformRef } from '@/types';

interface ManifestDetailProps {
  /** What `useImageDetail` returned for the selected tag (or null while loading). */
  kind: RegistryManifestKind | null;
  loading: boolean;
  error: Error | null;
  /** Breadcrumb prefix — `repo:tag`. Includes platform suffix when drilled in. */
  breadcrumb: string;
  /** When the user clicks a platform in an index, the page advances the URL state. */
  onSelectPlatform?: (osArch: string) => void;
}

type Tab = 'summary' | 'json';

/**
 * Right-pane manifest detail. Branches on the discriminated `kind`:
 *  - `image`: Summary tab shows config-derived fields; JSON tab shows the raw manifest.
 *  - `index`: Summary lists platform refs (click to drill in); JSON shows the index body.
 *  - `unknown`: Goes straight to JSON tab with an inline notice.
 */
export function ManifestDetail({ kind, loading, error, breadcrumb, onSelectPlatform }: ManifestDetailProps) {
  const [tab, setTab] = useState<Tab>('summary');

  if (loading) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading manifest…</div>;
  }
  if (error) {
    return (
      <div className="m-3 p-3 text-sm border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 rounded">
        <div className="font-medium mb-1">Failed to load manifest</div>
        <div className="text-xs">{error.message}</div>
      </div>
    );
  }
  if (!kind) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Select a tag to view its manifest.</div>;
  }

  // `unknown` kind always shows JSON only — no summary tab.
  const effectiveTab = kind.kind === 'unknown' ? 'json' : tab;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 font-mono truncate" title={breadcrumb}>
          {breadcrumb}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-1 truncate" title={kind.manifest.digest}>
          {kind.manifest.digest}
        </div>
      </div>

      {kind.kind !== 'unknown' && (
        <div className="border-b border-gray-200 dark:border-gray-700 flex">
          {(['summary', 'json'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 ${
                effectiveTab === t
                  ? 'border-blue-600 text-blue-700 dark:text-blue-300'
                  : 'border-transparent text-gray-600 dark:text-gray-400'
              }`}
            >
              {t === 'summary' ? 'Summary' : 'JSON'}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {effectiveTab === 'summary' && kind.kind === 'image' && <ImageSummary kind={kind} />}
        {effectiveTab === 'summary' && kind.kind === 'index' && (
          <IndexSummary platforms={kind.platforms} onSelectPlatform={onSelectPlatform} />
        )}
        {kind.kind === 'unknown' && (
          <div className="m-3 p-3 text-sm border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-900 dark:text-yellow-200 rounded">
            {kind.reason}. Showing raw JSON.
          </div>
        )}
        {effectiveTab === 'json' && (
          <pre className="m-3 p-3 max-h-[60vh] overflow-auto text-xs font-mono bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 rounded">
            {JSON.stringify(kind.manifest.body, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function ImageSummary({ kind }: { kind: Extract<RegistryManifestKind, { kind: 'image' }> }) {
  const cfg = kind.config;
  return (
    <dl className="p-4 grid grid-cols-[8rem_1fr] gap-y-2 gap-x-3 text-sm">
      <Field label="Media type" value={kind.manifest.mediaType} mono />
      <Field label="Size" value={`${kind.manifest.size ?? 0} B`} />
      <Field label="Created" value={cfg.created ? new Date(cfg.created).toLocaleString() : '—'} />
      <Field label="OS / Arch" value={cfg.os && cfg.architecture ? `${cfg.os}/${cfg.architecture}` : '—'} />
      <Field label="Working dir" value={cfg.config?.WorkingDir ?? '—'} mono />
      <Field
        label="Cmd"
        value={cfg.config?.Cmd?.length ? cfg.config.Cmd.join(' ') : '—'}
        mono
      />
      <dt className="text-gray-500 dark:text-gray-400 font-medium">Env</dt>
      <dd>
        {cfg.config?.Env?.length ? (
          <ul className="font-mono text-xs space-y-0.5">
            {cfg.config.Env.map((e, i) => <li key={i} className="break-all">{e}</li>)}
          </ul>
        ) : <span className="text-gray-400">—</span>}
      </dd>
      <dt className="text-gray-500 dark:text-gray-400 font-medium">History</dt>
      <dd>
        {cfg.history?.length ? (
          <ul className="text-xs space-y-1">
            {cfg.history.map((h, i) => (
              <li key={i} className="font-mono break-all">
                <span className="text-gray-500 mr-2">{new Date(h.created).toLocaleDateString()}</span>
                {h.created_by ?? ''}
              </li>
            ))}
          </ul>
        ) : <span className="text-gray-400">—</span>}
      </dd>
    </dl>
  );
}

function IndexSummary({
  platforms, onSelectPlatform,
}: {
  platforms: RegistryPlatformRef[];
  onSelectPlatform?: (osArch: string) => void;
}) {
  if (platforms.length === 0) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Index references no platform manifests.</div>;
  }
  return (
    <ul className="p-2">
      {platforms.map((p) => {
        const label = p.platform.variant
          ? `${p.platform.os}/${p.platform.architecture}/${p.platform.variant}`
          : `${p.platform.os}/${p.platform.architecture}`;
        return (
          <li key={p.digest}>
            <button
              onClick={() => onSelectPlatform?.(label)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded"
            >
              <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{label}</span>
              <span className="ml-auto text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                {p.digest.slice(0, 19)}…
              </span>
              <span className="text-xs text-gray-400">{p.size ? `${p.size} B` : ''}</span>
              <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-gray-500 dark:text-gray-400 font-medium">{label}</dt>
      <dd className={`text-gray-900 dark:text-gray-100 break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </>
  );
}
