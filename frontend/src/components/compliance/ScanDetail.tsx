'use client';

import { useState, useEffect } from 'react';
import { ArrowLeft, Loader2, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import api from '@/lib/api';
import { Pagination } from '@/components/ui/Pagination';
import { useServerPagination } from '@/hooks/useServerPagination';
import type { ComplianceScan, ComplianceAuditEntry } from '@/types/compliance';
import { SCAN_STATUS_CONFIG as STATUS_CONFIG } from '@/lib/compliance-styles';
import { RESULT_STYLES } from './_result-styles';

interface ScanDetailProps {
  scanId: string;
  onBack: () => void;
}

export default function ScanDetail({ scanId, onBack }: ScanDetailProps) {
  const [scan, setScan] = useState<ComplianceScan | null>(null);
  const [scanLoading, setScanLoading] = useState(true);

  // The scan-detail page has two parallel fetches: the scan record itself
  // (one-shot, no pagination) and the per-entity audit log (paginated).
  // useServerPagination handles the latter; the scan fetch stays inline.
  useEffect(() => {
    let cancelled = false;
    setScanLoading(true);
    api.getScan(scanId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) setScan(res.data.scan);
      })
      .catch(() => { /* handled by loading state */ })
      .finally(() => { if (!cancelled) setScanLoading(false); });
    return () => { cancelled = true; };
  }, [scanId]);

  const {
    items: auditEntries,
    pagination: auditPagination,
    loading: auditLoading,
    setOffset: setAuditOffset,
  } = useServerPagination<ComplianceAuditEntry, { scanId: string }>(
    async ({ offset, limit, filters }) => {
      const res = await api.getComplianceAuditLog({ scanId: filters.scanId, limit, offset });
      if (!res.success || !res.data) {
        return { items: [], pagination: { offset, limit, total: 0 } };
      }
      return {
        items: res.data.entries,
        pagination: res.data.pagination
          ? { offset: res.data.pagination.offset, limit: res.data.pagination.limit, total: res.data.pagination.total }
          : { offset, limit, total: res.data.entries.length },
      };
    },
    { scanId },
    25,
  );

  const loading = scanLoading || auditLoading;
  const handleAuditPageChange = (offset: number) => { setAuditOffset(offset); };
  // Page-size changes are not currently supported by useServerPagination's
  // public surface; keep the Pagination wired but treat resize as a reset.
  const handleAuditPageSizeChange = (_limit: number) => { setAuditOffset(0); };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" aria-label="Go back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">Scan not found.</div>
      </div>
    );
  }

  const cfg = STATUS_CONFIG[scan.status];
  const StatusIcon = cfg.icon;
  const progress = scan.totalEntities > 0 ? Math.round((scan.processedEntities / scan.totalEntities) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" aria-label="Go back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Scan Details</h2>
      </div>

      {/* Scan summary card */}
      <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Status</div>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.color}`}>
              <StatusIcon className={`h-3 w-3 ${scan.status === 'running' ? 'animate-spin' : ''}`} />
              {scan.status}
            </span>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Target</div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">{scan.target}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Progress</div>
            <div className="flex items-center gap-2">
              <div className="w-20 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${progress}%` }} />
              </div>
              <span className="text-xs text-gray-500">{scan.processedEntities}/{scan.totalEntities}</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Triggered</div>
            <div className="text-xs text-gray-600 dark:text-gray-400">{new Date(scan.createdAt).toLocaleString()}</div>
          </div>
        </div>
        <div className="flex gap-6 mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-1.5">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="text-sm font-medium text-green-600">{scan.passCount} passed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 text-yellow-600" />
            <span className="text-sm font-medium text-yellow-600">{scan.warnCount} warnings</span>
          </div>
          <div className="flex items-center gap-1.5">
            <XCircle className="h-4 w-4 text-red-600" />
            <span className="text-sm font-medium text-red-600">{scan.blockCount} blocked</span>
          </div>
        </div>
      </div>

      {/* Entity results */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Entity Results ({auditPagination.total})</h3>
        {auditEntries.length === 0 ? (
          <div className="text-center py-6 text-gray-500 dark:text-gray-400 text-sm">No audit entries for this scan.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Result</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entity</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Target</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rules</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Violations</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                  {auditEntries.map(entry => {
                    const r = RESULT_STYLES[entry.result] || RESULT_STYLES.pass;
                    return (
                      <tr key={entry.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${r.bg} ${r.text}`}>{r.label}</span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white">{entry.entityName || entry.entityId || '-'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{entry.target}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{entry.ruleCount}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{entry.violations?.length || 0}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{new Date(entry.createdAt).toLocaleTimeString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {auditPagination.total > auditPagination.limit && (
              <Pagination
                pagination={auditPagination}
                onPageChange={handleAuditPageChange}
                onPageSizeChange={handleAuditPageSizeChange}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
