'use client';

import { useState, useEffect, useRef } from 'react';
import { ShieldOff, Check, X, Plus, Loader2, Clock, Trash2, Upload } from 'lucide-react';
import api from '@/lib/api';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { useServerPagination } from '@/hooks/useServerPagination';
import type { ComplianceExemption } from '@/types/compliance';
import { EXEMPTION_STATUS_STYLES as STATUS_STYLES } from '@/lib/compliance-styles';
import { parseCsv } from '@/lib/csv';

interface ExemptionManagerProps {
  readOnly?: boolean;
}

export default function ExemptionManager({ readOnly = false }: ExemptionManagerProps) {
  const toast = useToast();
  // Read toast via a ref so the fetcher closure stays referentially stable —
  // useServerPagination compares filters by JSON, but the fetcher itself is
  // tracked by ref and we don't want toast-context churn to thrash it.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{ ruleId: string; entityType: 'plugin' | 'pipeline'; entityId: string; entityName: string; reason: string }>({ ruleId: '', entityType: 'plugin', entityId: '', entityName: '', reason: '' });
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number; total: number } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    items: exemptions,
    pagination,
    loading,
    error: fetchError,
    setOffset,
    refetch: fetchExemptions,
  } = useServerPagination<ComplianceExemption, { status: string }>(
    async ({ offset, limit, filters }) => {
      const params: Record<string, string | number> = { limit, offset };
      if (filters.status) params.status = filters.status;
      const res = await api.getExemptions(params);
      if (!res.success || !res.data) {
        return { items: [], pagination: { offset, limit, total: 0 } };
      }
      return {
        items: res.data.exemptions,
        pagination: res.data.pagination
          ? { offset: res.data.pagination.offset, limit: res.data.pagination.limit, total: res.data.pagination.total }
          : { offset, limit, total: res.data.exemptions.length },
      };
    },
    { status: statusFilter },
    10,
  );

  // Surface fetch errors as toasts (replaces the old try/catch inside the fetcher).
  useEffect(() => {
    if (fetchError) toastRef.current.error(fetchError.message || 'Failed to load exemptions');
  }, [fetchError]);

  const handlePageChange = (offset: number) => { setOffset(offset); };
  // Page-size changes were a no-op (pagination.limit isn't externally settable
  // and the previous code re-fetched with `0,limit` without persisting it).
  // Keep the Pagination prop wired but drive only the offset.
  const handlePageSizeChange = (_limit: number) => { setOffset(0); };

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
        toastRef.current.success('Exemption requested');
        fetchExemptions();
      }
    } catch (err) {
      toastRef.current.error(err instanceof Error ? err.message : 'Failed to create exemption');
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await api.reviewExemption(id, 'approved');
      toastRef.current.success('Exemption approved');
      fetchExemptions();
    } catch (err) {
      toastRef.current.error(err instanceof Error ? err.message : 'Failed to approve exemption');
    }
  };

  const handleReject = async (id: string) => {
    try {
      await api.reviewExemption(id, 'rejected', rejectionReason || undefined);
      setRejectingId(null);
      setRejectionReason('');
      toastRef.current.success('Exemption rejected');
      fetchExemptions();
    } catch (err) {
      toastRef.current.error(err instanceof Error ? err.message : 'Failed to reject exemption');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteExemption(id);
      toastRef.current.success('Exemption deleted');
      fetchExemptions();
    } catch (err) {
      toastRef.current.error(err instanceof Error ? err.message : 'Failed to delete exemption');
    }
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
          <FilterSelect
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter exemptions by status"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </FilterSelect>
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
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                title="Import exemptions from a CSV (columns: ruleId, entityType, entityId, reason; optional: entityName, expiresAt)"
              >
                <Upload className="h-4 w-4" /> Import CSV
              </Button>
              <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
                <Plus className="h-4 w-4" /> Request
              </Button>
            </>
          )}
        </div>
      </div>

      <ErrorAlert message={bulkError} />
      <SuccessAlert
        message={bulkResult && (
          <>
            Imported <strong>{bulkResult.created}</strong> exemption{bulkResult.created === 1 ? '' : 's'}
            {bulkResult.skipped > 0 && <> ({bulkResult.skipped} skipped of {bulkResult.total})</>}.
          </>
        )}
      />

      {showForm && (
        <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input aria-label="Rule ID" placeholder="Rule ID" value={form.ruleId} onChange={e => setForm(f => ({ ...f, ruleId: e.target.value }))} />
            <Select value={form.entityType} onChange={e => setForm(f => ({ ...f, entityType: e.target.value as 'plugin' | 'pipeline' }))}>
              <option value="plugin">Plugin</option>
              <option value="pipeline">Pipeline</option>
            </Select>
            <Input aria-label="Entity ID" placeholder="Entity ID" value={form.entityId} onChange={e => setForm(f => ({ ...f, entityId: e.target.value }))} />
            <Input aria-label="Entity Name (optional)" placeholder="Entity Name (optional)" value={form.entityName} onChange={e => setForm(f => ({ ...f, entityName: e.target.value }))} />
          </div>
          <Textarea aria-label="Reason for exemption" placeholder="Reason for exemption..." value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} rows={2} />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={handleCreate}>Submit Request</Button>
            <Button variant="secondary" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {exemptions.length === 0 ? (
        <TextEmptyState>No exemptions found.</TextEmptyState>
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
                          <IconButton restTone="success" onClick={() => handleApprove(ex.id)} title="Approve" aria-label="Approve">
                            <Check className="h-4 w-4" />
                          </IconButton>
                          <IconButton restTone="danger" onClick={() => openReject(ex.id)} title="Reject" aria-label="Reject">
                            <X className="h-4 w-4" />
                          </IconButton>
                        </>
                      )}
                      <IconButton tone="danger" onClick={() => handleDelete(ex.id)} title="Delete" aria-label="Delete">
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
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
                    <Input
                      value={rejectionReason}
                      onChange={e => setRejectionReason(e.target.value)}
                      placeholder="Reason for rejection (optional)"
                      className="flex-1"
                    />
                    <Button variant="danger" size="xs" onClick={() => handleReject(ex.id)}>
                      Confirm Reject
                    </Button>
                    <Button variant="secondary" size="xs" onClick={() => { setRejectingId(null); setRejectionReason(''); }}>
                      Cancel
                    </Button>
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
