// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Download, ListTree } from 'lucide-react';
import { severityLabel } from '@/lib/advisories';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { PluginVersionFindings } from '@/lib/api/plugin-vulnerability-types';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import { formatDateTime } from '@/lib/format';

/** The plugins page's advisory search, pre-filled with one advisory id. */
export function advisorySearchHref(advisoryId: string): string {
  return `/dashboard/plugins?tab=vulnerabilities&advisory=${encodeURIComponent(advisoryId)}`;
}

/** `12%` — EPSS is a 0–1 probability of exploitation in the next 30 days. */
function formatEpss(epss: number | undefined): string {
  if (epss == null || !Number.isFinite(epss)) return '—';
  const pct = epss * 100;
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(0)}%`;
}

/** Days since the scanner's vulnerability database was built, or null. */
function dbAgeDays(dbBuiltAt: string | null | undefined, now = Date.now()): number | null {
  if (!dbBuiltAt) return null;
  const t = Date.parse(dbBuiltAt);
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86_400_000);
}

/** The loaded finding list: counts, notices and the table. */
function FindingsBody({ data, onNavigate }: { data: PluginVersionFindings; onNavigate?: () => void }) {
  const s = data.summary;
  if (!s) {
    return <p className="text-xs text-fg-muted" data-testid="findings-none">No scan is stored for this version.</p>;
  }
  const dbAge = dbAgeDays(s.dbBuiltAt);
  const uncatalogued = s.uncataloguedBinaries ?? [];
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted" data-testid="findings-counts">
        {s.critical ?? 0} Critical · {s.high ?? 0} High · {s.medium ?? 0} Medium · {s.low ?? 0} Low
        {(s.kev ?? 0) > 0 && ` · ${s.kev} known-exploited`}
        {s.trigger && ` · ${s.trigger} scan`}
        {s.scannedAt && ` · ${formatDateTime(s.scannedAt)}`}
      </p>
      {dbAge !== null && (
        <p className={`text-xs ${dbAge > 7 ? 'text-warning-strong' : 'text-fg-muted'}`} data-testid="findings-db-age">
          Scanner database built {formatDateTime(s.dbBuiltAt)}{dbAge > 7 ? ` (${dbAge} days old — newer advisories are missing)` : ''}.
        </p>
      )}
      {uncatalogued.length > 0 && (
        <div role="note" className="rounded-md border border-warning-border bg-warning-bg p-2 text-xs text-fg" data-testid="findings-uncatalogued">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {uncatalogued.length} binar{uncatalogued.length === 1 ? 'y' : 'ies'} the scanner could not identify
          </p>
          <p className="mt-0.5">
            Vulnerabilities in these files are not counted above: they were copied in outside a package manager.
          </p>
          <p className="mt-1 font-mono break-all">{uncatalogued.slice(0, 10).join(', ')}{uncatalogued.length > 10 ? ` … +${uncatalogued.length - 10} more` : ''}</p>
        </div>
      )}
      {data.findings.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="findings-empty">No Critical or High findings.</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-md border border-default">
          <table className="w-full text-xs" aria-label="Vulnerability findings" data-testid="findings-table">
            <thead className="sticky top-0 bg-surface-muted text-left text-fg-muted">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">Severity</th>
                <th scope="col" className="px-2 py-1 font-medium">Advisory</th>
                <th scope="col" className="px-2 py-1 font-medium">Package</th>
                <th scope="col" className="px-2 py-1 font-medium">Fixed in</th>
                <th scope="col" className="px-2 py-1 font-medium" title="Probability of exploitation in the next 30 days (EPSS)">EPSS</th>
              </tr>
            </thead>
            <tbody>
              {data.findings.map((f) => (
                <tr key={`${f.id}:${f.packageName}:${f.packageVersion}`} className={`border-t border-default ${f.waived ? 'opacity-60' : ''}`}>
                  <td className="px-2 py-1">
                    <Badge color={f.severity === 'critical' ? 'red' : 'yellow'}>{severityLabel(f.severity)}</Badge>
                  </td>
                  <td className="px-2 py-1 font-mono">
                    <Link
                      href={advisorySearchHref(f.id)}
                      className="action-link"
                      title="Which plugins and pipelines this advisory affects"
                      onClick={onNavigate}
                    >
                      {f.id}
                    </Link>
                    {f.kev && <span className="ml-1 inline-block" title="CISA Known Exploited Vulnerability"><Badge color="red">KEV</Badge></span>}
                    {f.waived && <span className="ml-1 inline-block" title="Exempted by a vulnerability waiver"><Badge color="gray">Waived</Badge></span>}
                  </td>
                  <td className="px-2 py-1 font-mono break-all">{f.packageName}@{f.packageVersion}</td>
                  <td className="px-2 py-1 font-mono">{f.fixedIn.length > 0 ? f.fixedIn.join(', ') : <span className="text-fg-muted">no fix</span>}</td>
                  <td className="px-2 py-1">{formatEpss(f.epss)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.truncated && (
        <p className="text-xs text-fg-muted" data-testid="findings-truncated">
          The stored list was capped; download the CSV for every finding the scan kept.
        </p>
      )}
    </div>
  );
}

/**
 * A version's full Critical / High finding list (`GET /plugins/:id/findings`),
 * loaded on demand — the badges above it come from the list row and cost no
 * request, and most opens of the detail view never need the table. The CSV
 * download goes through the authenticated client for the same reason the SBOM
 * does: a plain link would carry no bearer token.
 */
export function PluginFindingsPanel({ pluginId, onNavigate }: {
  pluginId: string;
  /** Called when an advisory link leaves the view (the modal closes itself). */
  onNavigate?: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const findingsQ = useFetch(async (signal) => {
    const res = await api.getPluginFindings(pluginId, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load findings');
    return res.data;
  }, [pluginId], { enabled: open });

  const downloadCsv = async () => {
    setDownloading(true);
    try {
      const { blob, filename } = await api.downloadPluginFindingsCsv(pluginId);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(formatError(err, 'Findings download failed'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="plugin-findings-panel">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ListTree className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          {open ? 'Hide findings' : 'Show all findings'}
        </Button>
        <Button variant="outline" size="xs" onClick={downloadCsv} loading={downloading}>
          <Download className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          Download findings (CSV)
        </Button>
      </div>
      {open && (findingsQ.loading && !findingsQ.data ? (
        <Skeleton className="h-16 w-full" />
      ) : findingsQ.error ? (
        <RetryError message={formatError(findingsQ.error, 'Failed to load findings')} onRetry={findingsQ.refetch} />
      ) : findingsQ.data ? (
        <FindingsBody data={findingsQ.data} onNavigate={onNavigate} />
      ) : null)}
    </div>
  );
}
