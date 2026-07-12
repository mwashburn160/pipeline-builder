'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Loader2, AlertTriangle, CheckCircle, XCircle, Square, ShieldOff } from 'lucide-react';
import api from '@/lib/api';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useServerPagination } from '@/hooks/useServerPagination';
import type { ComplianceScan, ComplianceAuditEntry, RuleTarget } from '@/types/compliance';
import { SCAN_STATUS_CONFIG as STATUS_CONFIG, RESULT_STYLES } from '@/lib/compliance-styles';

/** The subset of an audit row needed to pre-fill an exemption request. */
interface ExemptTarget {
  entityId: string;
  entityType: RuleTarget;
  entityName: string;
  /** The rules this entity violated in the scan — the user picks which to exempt. */
  rules: { ruleId: string; ruleName: string }[];
}

/** Pull the violated rules (ruleId + ruleName) off an audit entry's opaque violations. */
function violatedRules(entry: ComplianceAuditEntry): { ruleId: string; ruleName: string }[] {
  return (entry.violations as Array<{ ruleId?: unknown; ruleName?: unknown }>)
    .filter((v) => typeof v.ruleId === 'string' && v.ruleId)
    .map((v) => ({ ruleId: String(v.ruleId), ruleName: v.ruleName ? String(v.ruleName) : String(v.ruleId) }));
}

interface ScanDetailProps {
  scanId: string;
  onBack: () => void;
}

export default function ScanDetail({ scanId, onBack }: ScanDetailProps) {
  const toast = useToast();
  const [scan, setScan] = useState<ComplianceScan | null>(null);
  const [scanLoading, setScanLoading] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Exemption request modal, opened from a violating row.
  const [exemptTarget, setExemptTarget] = useState<ExemptTarget | null>(null);
  const [exemptForm, setExemptForm] = useState<{ ruleId: string; reason: string; expiresAt: string }>({ ruleId: '', reason: '', expiresAt: '' });
  const [exemptSubmitting, setExemptSubmitting] = useState(false);

  // The scan-detail page has two parallel fetches: the scan record itself
  // (one-shot, no pagination) and the per-entity audit log (paginated).
  // useServerPagination handles the latter; the scan fetch stays inline.
  const fetchScan = useCallback(async () => {
    setScanLoading(true);
    setScanError(null);
    try {
      const res = await api.getScan(scanId);
      if (res.success && res.data) setScan(res.data.scan);
      else setScanError(res.message || 'Failed to load scan');
    } catch {
      setScanError('Failed to load scan');
    } finally {
      setScanLoading(false);
    }
  }, [scanId]);

  useEffect(() => { fetchScan(); }, [fetchScan]);

  const {
    items: auditEntries,
    pagination: auditPagination,
    loading: auditLoading,
    setOffset: setAuditOffset,
    refetch: refetchAudit,
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

  // Cancel a running scan (mirrors ScanManager's cancel + confirm, then refetches).
  const handleCancel = async () => {
    if (!scan || !window.confirm('Cancel this running scan? Entities not yet processed will be skipped.')) return;
    setCancelling(true);
    try {
      const res = await api.cancelScan(scan.id);
      if (res.success) {
        toast.success('Scan cancelled');
        await fetchScan();
      } else {
        toast.error(res.message || 'Failed to cancel scan');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel scan');
    } finally {
      setCancelling(false);
    }
  };

  // Open the exemption request modal, pre-filled from a violating row.
  const openExempt = (entry: ComplianceAuditEntry) => {
    const rules = violatedRules(entry);
    setExemptTarget({
      entityId: entry.entityId ?? '',
      entityType: entry.target,
      entityName: entry.entityName ?? '',
      rules,
    });
    setExemptForm({ ruleId: rules[0]?.ruleId ?? '', reason: '', expiresAt: '' });
  };

  const handleExemptSubmit = async () => {
    if (!exemptTarget || !exemptForm.ruleId || !exemptForm.reason.trim()) return;
    setExemptSubmitting(true);
    try {
      const res = await api.createExemption({
        ruleId: exemptForm.ruleId,
        entityType: exemptTarget.entityType,
        entityId: exemptTarget.entityId,
        entityName: exemptTarget.entityName || undefined,
        reason: exemptForm.reason.trim(),
        expiresAt: exemptForm.expiresAt || undefined,
      });
      if (res.success) {
        toast.success('Exemption requested');
        setExemptTarget(null);
        refetchAudit();
      } else {
        toast.error(res.message || 'Failed to request exemption');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to request exemption');
    } finally {
      setExemptSubmitting(false);
    }
  };

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
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          {scanError ?? 'Scan not found.'}
          {scanError && <button onClick={fetchScan} className="ml-2 underline hover:no-underline text-red-600 dark:text-red-400">Retry</button>}
        </div>
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
        {scan.status === 'running' && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            <Square className="h-3.5 w-3.5" /> {cancelling ? 'Cancelling...' : 'Cancel scan'}
          </button>
        )}
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
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                  {auditEntries.map(entry => {
                    const r = RESULT_STYLES[entry.result] || RESULT_STYLES.pass;
                    // Only block/warn rows with an entity + a violated rule can be exempted.
                    const canExempt = (entry.result === 'block' || entry.result === 'warn')
                      && !!entry.entityId
                      && violatedRules(entry).length > 0;
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
                        <td className="px-4 py-3 text-right">
                          {canExempt && (
                            <button
                              onClick={() => openExempt(entry)}
                              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 hover:bg-orange-100 dark:hover:bg-orange-900/40 transition-colors"
                              title="Request an exemption for this violation"
                            >
                              <ShieldOff className="h-3.5 w-3.5" /> Exempt
                            </button>
                          )}
                        </td>
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

      {exemptTarget && (
        <Modal
          title="Request Exemption"
          onClose={() => setExemptTarget(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setExemptTarget(null)} className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg">Cancel</button>
              <button
                onClick={handleExemptSubmit}
                disabled={exemptSubmitting || !exemptForm.ruleId || !exemptForm.reason.trim()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {exemptSubmitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Entity</label>
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white truncate" title={exemptTarget.entityName || exemptTarget.entityId}>
                  {exemptTarget.entityName || exemptTarget.entityId}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Entity Type</label>
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white capitalize">
                  {exemptTarget.entityType}
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Rule *</label>
              <select
                value={exemptForm.ruleId}
                onChange={e => setExemptForm(f => ({ ...f, ruleId: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              >
                {exemptTarget.rules.map(rule => (
                  <option key={rule.ruleId} value={rule.ruleId}>{rule.ruleName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Reason *</label>
              <textarea
                value={exemptForm.reason}
                onChange={e => setExemptForm(f => ({ ...f, reason: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                rows={3}
                placeholder="Why should this violation be exempted?"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Expires (optional)</label>
              <input
                type="date"
                value={exemptForm.expiresAt}
                onChange={e => setExemptForm(f => ({ ...f, expiresAt: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
