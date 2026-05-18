// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { CopyButton } from '@/components/ui/CopyButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { api } from '@/lib/api';
import type { RegistryManifestKind, RegistryPlatformRef } from '@/types';

interface BreadcrumbSegment {
  /** Label shown in the breadcrumb (e.g. `org-acme/foo:rc1` or `linux/amd64`). */
  label: string;
  /** When set, clicking the segment fires this callback (truncates the URL state to this point). */
  onClick?: () => void;
}

interface ManifestDetailProps {
  kind: RegistryManifestKind | null;
  loading: boolean;
  error: Error | null;
  /** Segments rendered as breadcrumbs; earlier segments are clickable to walk back. */
  breadcrumbs: BreadcrumbSegment[];
  /** Drilled-into a multi-arch index? Triggered when user clicks a platform row. */
  onSelectPlatform?: (osArch: string) => void;
  /** Repo name — needed to scan for tags pointing to this digest. */
  repo: string | null;
}

type Tab = 'summary' | 'json';

/**
 * Right-pane manifest detail. Branches on the discriminated `kind`:
 *  - `image`: Summary tab shows config-derived fields; JSON tab shows the raw manifest.
 *  - `index`: Summary lists platform refs (click to drill in); JSON shows the index body.
 *  - `unknown`: Goes straight to JSON tab with an inline notice.
 *
 * Also shows a "Other tags pointing to this digest" expandable section so
 * the operator sees the blast radius of a delete without leaving the page.
 */
export function ManifestDetail({
  kind, loading, error, breadcrumbs, onSelectPlatform, repo,
}: ManifestDetailProps) {
  const [tab, setTab] = useState<Tab>('summary');

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    );
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
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        Select a tag to view its manifest. Multi-arch tags expand into per-platform manifests; click a platform to drill in.
      </div>
    );
  }

  // `unknown` kind always shows JSON only — no summary tab.
  const effectiveTab = kind.kind === 'unknown' ? 'json' : tab;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 font-mono truncate">
          {breadcrumbs.map((seg, i) => (
            <span key={i}>
              {i > 0 && <span className="text-gray-400 mx-1">→</span>}
              {seg.onClick ? (
                <button
                  onClick={seg.onClick}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                  title="Back to this level"
                >
                  {seg.label}
                </button>
              ) : (
                <span>{seg.label}</span>
              )}
            </span>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate flex-1" title={kind.manifest.digest}>
            {kind.manifest.digest}
          </span>
          <CopyButton text={kind.manifest.digest} />
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
        {repo && kind.manifest.digest && (
          <TagsForDigest repo={repo} digest={kind.manifest.digest} />
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

/**
 * Eagerly scans the list of other tags in `repo` that point to the given
 * `digest`. Useful so the operator sees the blast radius of a delete
 * before they even hit the delete button — and as a general "what else is
 * this manifest tagged as?" reference.
 *
 * Default-open behavior: when 2+ tags share the digest, auto-open the
 * disclosure so the blast radius is visible without an extra click. The
 * operator can still toggle it closed; `manualOpen` overrides the auto
 * default after any user interaction.
 */
function TagsForDigest({ repo, digest }: { repo: string; digest: string }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [tags, setTags] = useState<string[] | null>(null);
  const [scanning, setScanning] = useState(true);
  const [scannedCount, setScannedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    setScannedCount(0);
    setTags(null);
    setManualOpen(null);
    (async () => {
      try {
        const res = await api.listImageTags(repo);
        if (cancelled) return;
        const all = res.data?.tags ?? [];
        setTotalCount(all.length);
        // Cap at 50 to bound the scan; parallelize for speed.
        const toScan = all.slice(0, 50);
        const found: string[] = [];
        let done = 0;
        const fetchOne = async (t: string) => {
          try {
            const m = await api.getImageManifest(repo, t);
            if (m.data?.digest === digest) found.push(t);
          } catch {
            // skip
          }
          done++;
          if (!cancelled) setScannedCount(done);
        };
        // Bounded concurrency: 8 in flight at a time.
        for (let i = 0; i < toScan.length; i += 8) {
          if (cancelled) return;
          await Promise.all(toScan.slice(i, i + 8).map(fetchOne));
        }
        if (!cancelled) {
          setTags(found.sort());
          setScanning(false);
        }
      } catch {
        if (!cancelled) {
          setTags([]);
          setScanning(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [repo, digest]);

  // Auto-open if 2+ tags share this digest. Manual toggle overrides.
  const autoOpen = !!tags && tags.length > 1;
  const isOpen = manualOpen ?? autoOpen;
  const sharedCount = tags?.length ?? 0;

  return (
    <details
      open={isOpen}
      className="mx-3 mb-3 border border-gray-200 dark:border-gray-700 rounded text-sm"
      onToggle={(e) => setManualOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="px-3 py-2 cursor-pointer text-gray-700 dark:text-gray-300 font-medium flex items-center gap-2">
        <span>Other tags pointing to this digest</span>
        {!scanning && (
          <span className={`ml-auto text-xs font-normal ${sharedCount > 1 ? 'text-orange-700 dark:text-orange-300' : 'text-gray-500'}`}>
            {sharedCount === 0 ? '(none)' : `(${sharedCount} found)`}
          </span>
        )}
      </summary>
      <div className="px-3 pb-3">
        {scanning && (
          <div className="text-xs text-gray-500">
            Scanning… {scannedCount}/{Math.min(totalCount, 50)} tag(s) checked
          </div>
        )}
        {!scanning && tags && tags.length === 0 && (
          <div className="text-xs text-gray-500">No other tags share this digest{totalCount > 50 ? ' (scan capped at 50 — repo has more)' : ''}.</div>
        )}
        {!scanning && tags && tags.length > 0 && (
          <ul className="font-mono text-xs space-y-0.5">
            {tags.map((t) => <li key={t}>{t}</li>)}
            {totalCount > 50 && <li className="italic text-gray-500">…and {totalCount - 50} tag(s) not scanned</li>}
          </ul>
        )}
      </div>
    </details>
  );
}
