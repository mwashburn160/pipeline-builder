'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldOff, Check, X, Plus, Loader2, Clock, Trash2, Upload } from 'lucide-react';
import api from '@/lib/api';
import { Pagination, type PaginationState } from '@/components/ui/Pagination';
import type { ComplianceExemption } from '@/types/compliance';
import { EXEMPTION_STATUS_STYLES as STATUS_STYLES } from '@/lib/compliance-styles';
import { parseCsv } from '@/lib/csv';

interface ExemptionManagerProps {
  readOnly?: boolean;
}

export default function ExemptionManager({ readOnly = false }: ExemptionManagerProps) {
  const [exemptions, setExemptions] = useState<ComplianceExemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{ ruleId: string; entityType: 'plugin' | 'pipeline'; entityId: string; entityName: string; reason: string }>({ ruleId: '', entityType: 'plugin', entityId: '', entityName: '', reason: '' });
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ limit: 10, offset: 0, total: 0 });
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number; total: number } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchExemptions = useCallback(async (offset = pagination.offset, limit = pagination.limit) => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit, offset };
      if (statusFilter) params.status = statusFilter;
      const res = await api.getExemptions(params);
      if (res.success && res.data) {
        setExemptions(res.data.exemptions);
        if (res.data.pagination) {
          setPagination({ limit: res.data.pagination.limit, offset: res.data.pagination.offset, total: res.data.pagination.total });
        }
      }
    } catch { /* handled by loading state */ }
    setLoading(false);
  }, [statusFilter, pagination.offset, pagination.limit]);

  useEffect(() => { fetchExemptions(); }, [fetchExemptions]);

  useEffect(() => {
    setPagination(prev => ({ ...prev, offset: 0 }));
  }, [statusFilter]);

  const handlePageChange = (offset: number) => { fetchExemptions(offset, pagination.limit); };
  const handlePageSizeChange = (limit: number) => { fetchExemptions(0, limit); };

  const handleCreate = async () => {
    if (!form.ruleId || !form.entityId || !form.reason) return;
    try {
      const res = await api.createExemption({
        ruleId: form.ruleId,
        entityType: form.entityType,
        entityId: form.entityId,
        entityName: form.entityName || undefined,
        reason: form.reason,
      });
      if (res.success) {
        setShowForm(false);
        setForm({ ruleId: '', entityType: 'plugin', entityId: '', entityName: '', reason: '' });
        fetchExemptions();
      }
    } catch { /* handled by API layer */ }
  };

  const handleApprove = async (id: string) => {
    try {
      await api.reviewExemption(id, 'approved');
      fetchExemptions();
    } catch { /* handled by API layer */ }
  };

  const handleReject = async (id: string) => {
    try {
      await api.reviewExemption(id, 'rejected', rejectionReason || undefined);
      setRejectingId(null);
      setRejectionReason('');
      fetchExemptions();
    } catch { /* handled by API layer */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteExemption(id);
      fetchExemptions();
    } catch { /* handled by API layer */ }
  };

  // Bulk-import exemptions from a user-uploaded CSV.
  // Required columns: ruleId, entityType, entityId, reason.
  // Optional: entityName, expiresAt (ISO datetime).
  // Caps at 500 rows server-side; the frontend validates each row before send.
  const REQUIRED_COLS = ['ruleId', 'entityType', 'entityId', 'reason'];
  const handleBulkImport = async (file: File) => {
    setBulkError(null);
    setBulkResult(null);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.rowCount === 0) {
        setBulkError('CSV is empty.');
        return;
      }
      const missing = REQUIRED_COLS.filter((c) => !parsed.headers.includes(c));
      if (missing.length > 0) {
        setBulkError(`Missing required column(s): ${missing.join(', ')}. Required: ${REQUIRED_COLS.join(', ')}.`);
        return;
      }
      if (parsed.rowCount > 500) {
        setBulkError(`Row count (${parsed.rowCount}) exceeds the 500-row import limit. Split the file and retry.`);
        return;
      }

      const exemptions = parsed.rows
        .filter((r) => r.ruleId && r.entityId && r.reason)
        .map((r) => ({
          ruleId: r.ruleId,
          entityType: (r.entityType === 'pipeline' ? 'pipeline' : 'plugin') as 'plugin' | 'pipeline',
          entityId: r.entityId,
          entityName: r.entityName || undefined,
          reason: r.reason,
          expiresAt: r.expiresAt || undefined,
        }));

      if (exemptions.length === 0) {
        setBulkError('No rows had all required fields filled.');
        return;
      }

      const res = await api.bulkCreateExemptions(exemptions);
      if (res.success && res.data) {
        setBulkResult({ created: res.data.created, skipped: res.data.skipped, total: parsed.rowCount });
        fetchExemptions();
      }
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to import CSV.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openReject = (id: string) => {
    setRejectingId(id);
    setRejectionReason('');
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldOff className="h-5 w-5 text-orange-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Exemptions</h2>
        </div>
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          {!readOnly && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleBulkImport(f);
                }}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 rounded-lg bg-gray-200 dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
                title="Import exemptions from a CSV (columns: ruleId, entityType, entityId, reason; optional: entityName, expiresAt)"
              >
                <Upload className="h-4 w-4" /> Import CSV
              </button>
              <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700">
                <Plus className="h-4 w-4" /> Request
              </button>
            </>
          )}
        </div>
      </div>

      {bulkError && (
        <div className="p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
          {bulkError}
        </div>
      )}
      {bulkResult && (
        <div className="p-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-300">
          Imported <strong>{bulkResult.created}</strong> exemption{bulkResult.created === 1 ? '' : 's'}
          {bulkResult.skipped > 0 && <> ({bulkResult.skipped} skipped of {bulkResult.total})</>}.
        </div>
      )}

      {showForm && (
        <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Rule ID" value={form.ruleId} onChange={e => setForm(f => ({ ...f, ruleId: e.target.value }))} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" />
            <select value={form.entityType} onChange={e => setForm(f => ({ ...f, entityType: e.target.value as 'plugin' | 'pipeline' }))} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
              <option value="plugin">Plugin</option>
              <option value="pipeline">Pipeline</option>
            </select>
            <input placeholder="Entity ID" value={form.entityId} onChange={e => setForm(f => ({ ...f, entityId: e.target.value }))} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" />
            <input placeholder="Entity Name (optional)" value={form.entityName} onChange={e => setForm(f => ({ ...f, entityName: e.target.value }))} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" />
          </div>
          <textarea placeholder="Reason for exemption..." value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" rows={2} />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Submit Request</button>
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {exemptions.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">No exemptions found.</div>
      ) : (
        <>
        <div className="space-y-2">
          {exemptions.map((ex: ComplianceExemption) => {
            const style = STATUS_STYLES[ex.status];
            return (
              <div key={ex.id} className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${style.bg} ${style.text}`}>{ex.status}</span>
                    <div>
                      <div className="text-sm text-gray-900 dark:text-white">{ex.entityName || ex.entityId}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{ex.entityType} — {ex.reason.slice(0, 80)}{ex.reason.length > 80 ? '...' : ''}</div>
                    </div>
                    {ex.expiresAt && (
                      <div className="flex items-center gap-1 text-xs text-gray-400">
                        <Clock className="h-3 w-3" />
                        {new Date(ex.expiresAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="flex items-center gap-1">
                      {ex.status === 'pending' && (
                        <>
                          <button onClick={() => handleApprove(ex.id)} className="p-1.5 rounded-lg text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20" title="Approve" aria-label="Approve">
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => openReject(ex.id)}
                            className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                            title="Reject"
                            aria-label="Reject"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </>
                      )}
                      <button onClick={() => handleDelete(ex.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete" aria-label="Delete">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
                {ex.status === 'rejected' && ex.rejectionReason && (
                  <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded px-2 py-1">
                    Rejection reason: {ex.rejectionReason}
                  </div>
                )}
                {rejectingId === ex.id && (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={rejectionReason}
                      onChange={e => setRejectionReason(e.target.value)}
                      placeholder="Reason for rejection (optional)"
                      className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
                    />
                    <button onClick={() => handleReject(ex.id)} className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700">
                      Confirm Reject
                    </button>
                    <button onClick={() => { setRejectingId(null); setRejectionReason(''); }} className="px-3 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg">
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {pagination.total > pagination.limit && (
          <Pagination
            pagination={pagination}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        )}
        </>
      )}
    </div>
  );
}
