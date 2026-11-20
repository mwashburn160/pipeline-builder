'use client';

import { Badge } from '@/components/ui/Badge';
import { useState, useEffect, useRef } from 'react';
import { ShieldOff, Check, X, Plus, Clock, Trash2, Upload, CalendarClock } from 'lucide-react';
import api from '@/lib/api';
import { useMutation } from '@/hooks/useMutation';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RetryError } from '@/components/ui/RetryError';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { useServerPagination } from '@/hooks/useServerPagination';
import { useDelete } from '@/hooks/useDelete';
import type { ComplianceExemption } from '@/types/compliance';
import { RULE_TARGET_IDS, RULE_TARGET_LABELS, EXEMPTION_STATUS_IDS, EXEMPTION_STATUS_META } from '@/lib/compliance-styles';
import { parseCsv } from '@/lib/csv';
import { formatDate } from '@/lib/format';
import { formatError } from '@/lib/constants';
import { localDay, localDayEndIso } from '@/lib/local-day';
import { LoadingSpinner } from '@/components/ui/Loading';
import { StatusPill } from '@/components/ui/StatusPill';

interface ExemptionManagerProps {
  /** No `compliance:write`: no approve / reject / extend / delete. Requesting
   *  and the CSV import stay — those routes need only `compliance:read`. */
  readOnly?: boolean;
  /** A read-only (impersonation) session, which refuses even the
   *  `compliance:read` POSTs: no request or import either. */
  sessionReadOnly?: boolean;
}

export default function ExemptionManager({ readOnly = false, sessionReadOnly = false }: ExemptionManagerProps) {
  const canRequest = !sessionReadOnly;
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
  // Submit had no in-flight state: repeated clicks fired N create calls, and an
  // incomplete form did nothing at all (a bare `return`) with no explanation.
  const [rejectionReason, setRejectionReason] = useState('');
  /** The exemption whose review (approve / reject) is in flight — a second
   *  click would send a second `PUT /:id/review`, which the server refuses. */
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  // Extend-expiry form: the exemption being extended, the chosen local day, and
  // the server's refusal (shown in place so the date can be corrected).
  const [extendingId, setExtendingId] = useState<string | null>(null);
  const [extendDay, setExtendDay] = useState('');
  const [extendError, setExtendError] = useState<string | null>(null);
  const [extending, setExtending] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number; total: number } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    items: exemptions,
    pagination,
    loading,
    error: fetchError,
    setOffset,
    setLimit,
    refetch: fetchExemptions,
  } = useServerPagination<ComplianceExemption, { status: string }>(
    async ({ offset, limit, filters }) => {
      const params: Record<string, string | number> = { limit, offset };
      if (filters.status) params.status = filters.status;
      const res = await api.getExemptions(params);
      // A refused read is an error, not "no exemptions": an empty list here reads
      // as "nothing is exempted" while exemptions may well be in force.
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to load exemptions');
      return {
        items: res.data.exemptions,
        pagination: res.data.pagination
          ? { offset: res.data.pagination.offset, limit: res.data.pagination.limit, total: res.data.pagination.total }
          : { offset, limit, total: res.data.exemptions.length },
      };
    },
    { status: statusFilter },
  );

  // Surface fetch errors as toasts.
  useEffect(() => {
    if (fetchError) toastRef.current.error(fetchError.message || 'Failed to load exemptions');
  }, [fetchError]);

  const create = useMutation({
    fn: async (data: typeof form) => {
      const res = await api.createExemption({
        ruleId: data.ruleId,
        entityType: data.entityType,
        entityId: data.entityId,
        entityName: data.entityName || undefined,
        reason: data.reason,
      });
      if (!res.success) throw new Error(res.message || 'Failed to create exemption');
      return res;
    },
    errorFallback: 'Failed to create exemption',
    toast: { error: true },
    onSuccess: () => {
      setShowForm(false);
      setForm({ ruleId: '', entityType: 'plugin', entityId: '', entityName: '', reason: '' });
      toastRef.current.success('Exemption requested');
      fetchExemptions();
    },
  });
  const submitting = create.pending;

  const handleCreate = async () => {
    if (!form.ruleId || !form.entityId || !form.reason) return;
    await create.run(form);
  };

  const handleApprove = async (id: string) => {
    if (reviewingId) return;
    setReviewingId(id);
    try {
      await api.reviewExemption(id, 'approved');
      toastRef.current.success('Exemption approved');
      fetchExemptions();
    } catch (err) {
      toastRef.current.error(formatError(err, 'Failed to approve exemption'));
    } finally {
      setReviewingId(null);
    }
  };

  const handleReject = async (id: string) => {
    if (reviewingId) return;
    setReviewingId(id);
    try {
      await api.reviewExemption(id, 'rejected', rejectionReason || undefined);
      setRejectingId(null);
      setRejectionReason('');
      toastRef.current.success('Exemption rejected');
      fetchExemptions();
    } catch (err) {
      toastRef.current.error(formatError(err, 'Failed to reject exemption'));
    } finally {
      setReviewingId(null);
    }
  };

  // `useDelete` owns the step-up replay: a delete refused pending re-auth
  // completes and refreshes once the person confirms in the global dialog.
  const del = useDelete<{ id: string; label: string }>(
    (ex) => api.deleteExemption(ex.id),
    () => { toastRef.current.success('Exemption deleted'); fetchExemptions(); },
    (err) => toastRef.current.error(formatError(err, 'Failed to delete exemption')),
  );

  // Bulk-import exemptions from a user-uploaded CSV.
  // Required columns: ruleId, entityType, entityId, reason.
  // Optional: entityName, expiresAt (ISO datetime).
  // Caps at 500 rows server-side; entityType is validated here before send.
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

      // entityType is VALIDATED, not coerced: coercing anything but the exact
      // string `pipeline` to `'plugin'` would turn a row saying `Pipeline` or
      // `pipeline ` (cells are not trimmed) into a PLUGIN exemption carrying the
      // pipeline's id — reported as created, and never exempting the pipeline. Trim and case-fold, and refuse the file
      // rather than guess.
      const badType: number[] = [];
      const parsedExemptions = parsed.rows
        .map((r, i) => ({ r, row: i + 2 })) // +2: 1-based, after the header
        .filter(({ r }) => r.ruleId?.trim() && r.entityId?.trim() && r.reason?.trim())
        .map(({ r, row }) => {
          const entityType = (r.entityType ?? '').trim().toLowerCase();
          if (entityType !== 'plugin' && entityType !== 'pipeline') badType.push(row);
          return {
            ruleId: r.ruleId.trim(),
            entityType: entityType as 'plugin' | 'pipeline',
            entityId: r.entityId.trim(),
            entityName: r.entityName?.trim() || undefined,
            reason: r.reason.trim(),
            expiresAt: r.expiresAt?.trim() || undefined,
          };
        });

      if (badType.length > 0) {
        setBulkError(
          `entityType must be "plugin" or "pipeline" — check row(s) ${badType.slice(0, 10).join(', ')}`
          + `${badType.length > 10 ? ` and ${badType.length - 10} more` : ''}. Nothing was imported.`,
        );
        return;
      }

      if (parsedExemptions.length === 0) {
        setBulkError('No rows had all required fields filled.');
        return;
      }

      const res = await api.bulkCreateExemptions(parsedExemptions);
      if (res.success && res.data) {
        setBulkResult({ created: res.data.created, skipped: res.data.skipped, total: parsed.rowCount });
        fetchExemptions();
      } else {
        setBulkError(res.message || 'The import was refused. Nothing was imported.');
      }
    } catch (err) {
      setBulkError(formatError(err, 'Failed to import CSV.'));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openExtend = (id: string) => {
    setExtendingId(id);
    setExtendDay('');
    setExtendError(null);
  };
  const closeExtend = () => {
    setExtendingId(null);
    setExtendDay('');
    setExtendError(null);
  };

  const handleExtend = async (id: string) => {
    if (!extendDay || extending) return;
    setExtending(true);
    setExtendError(null);
    try {
      // The END of the chosen day in the viewer's time zone: "valid until the
      // 30th" covers the 30th.
      await api.extendExemptionExpiry(id, localDayEndIso(extendDay));
      closeExtend();
      toastRef.current.success('Exemption expiry extended');
      fetchExemptions();
    } catch (err) {
      setExtendError(formatError(err, 'Failed to extend the exemption'));
    } finally {
      setExtending(false);
    }
  };

  const openReject = (id: string) => {
    setRejectingId(id);
    setRejectionReason('');
  };

  // Only the FIRST load blanks the panel: a re-read after approve / reject /
  // import keeps the list (and an open reject form) on screen.
  if (loading && exemptions.length === 0 && !fetchError) {
    return <div className="flex items-center justify-center py-12"><LoadingSpinner label="Loading exemptions" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldOff className="h-5 w-5 text-warning" />
          <h2 className="text-lg font-semibold text-fg">Exemptions</h2>
        </div>
        <div className="flex gap-2">
          <FilterSelect
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter exemptions by status"
          >
            <option value="">All statuses</option>
            {EXEMPTION_STATUS_IDS.map((st) => <option key={st} value={st}>{EXEMPTION_STATUS_META[st].label}</option>)}
          </FilterSelect>
          {canRequest && (
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

      {canRequest && showForm && (
        <div className="p-4 rounded-lg border border-info-border bg-info-bg space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input aria-label="Rule ID" placeholder="Rule ID" value={form.ruleId} onChange={e => setForm(f => ({ ...f, ruleId: e.target.value }))} />
            <Select value={form.entityType} onChange={e => setForm(f => ({ ...f, entityType: e.target.value as 'plugin' | 'pipeline' }))}>
              {RULE_TARGET_IDS.map((t) => <option key={t} value={t}>{RULE_TARGET_LABELS[t]}</option>)}
            </Select>
            <Input aria-label="Entity ID" placeholder="Entity ID" value={form.entityId} onChange={e => setForm(f => ({ ...f, entityId: e.target.value }))} />
            <Input aria-label="Entity name (optional)" placeholder="Entity name (optional)" value={form.entityName} onChange={e => setForm(f => ({ ...f, entityName: e.target.value }))} />
          </div>
          <Textarea aria-label="Reason for exemption" placeholder="Reason for exemption..." value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} rows={2} />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreate}
              loading={submitting}
              disabled={!form.ruleId || !form.entityId || !form.reason}
            >
              Submit Request
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {fetchError ? (
        <RetryError message={formatError(fetchError, 'Failed to load exemptions')} onRetry={fetchExemptions} />
      ) : exemptions.length === 0 ? (
        <TextEmptyState>No exemptions found.</TextEmptyState>
      ) : (
        <>
        <div className="space-y-2">
          {exemptions.map((ex: ComplianceExemption) => {
            const statusColor = EXEMPTION_STATUS_META[ex.status]?.color ?? 'gray';
            // Only an approved exemption that has an expiry and has not lapsed
            // can be extended; anything else is a new request.
            const extendable = ex.status === 'approved' && !!ex.expiresAt && new Date(ex.expiresAt).getTime() > Date.now();
            return (
              <div key={ex.id} className="p-3 rounded-lg border border-default bg-surface">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge color={statusColor}>{EXEMPTION_STATUS_META[ex.status]?.label ?? ex.status}</Badge>
                    <div>
                      <div className="text-sm text-fg">{ex.entityName || ex.entityId}</div>
                      <div className="text-xs text-fg-muted">{ex.entityType} — {ex.reason.slice(0, 80)}{ex.reason.length > 80 ? '...' : ''}</div>
                    </div>
                    {ex.expiresAt && (
                      <div className="flex items-center gap-1 text-xs text-fg-subtle">
                        <Clock className="h-3 w-3" />
                        {formatDate(ex.expiresAt)}
                      </div>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="flex items-center gap-1">
                      {ex.status === 'pending' && (
                        <>
                          <IconButton restTone="success" onClick={() => handleApprove(ex.id)} disabled={reviewingId === ex.id} title="Approve" aria-label="Approve">
                            <Check className="h-4 w-4" />
                          </IconButton>
                          <IconButton restTone="danger" onClick={() => openReject(ex.id)} disabled={reviewingId === ex.id} title="Reject" aria-label="Reject">
                            <X className="h-4 w-4" />
                          </IconButton>
                        </>
                      )}
                      {extendable && (
                        <IconButton onClick={() => openExtend(ex.id)} title="Extend expiry" aria-label="Extend expiry">
                          <CalendarClock className="h-4 w-4" />
                        </IconButton>
                      )}
                      <IconButton tone="danger" onClick={() => del.open({ id: ex.id, label: ex.entityName || ex.entityId })} title="Delete" aria-label="Delete">
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  )}
                </div>
                {ex.status === 'rejected' && ex.rejectionReason && (
                  <div className="mt-2 text-xs text-danger bg-danger-bg rounded px-2 py-1">
                    Rejection reason: {ex.rejectionReason}
                  </div>
                )}
                {!readOnly && extendable && extendingId === ex.id && (
                  <div className="mt-2 space-y-2">
                    <div className="flex gap-2 items-center">
                      <Input
                        type="date"
                        aria-label="New expiry date"
                        value={extendDay}
                        min={localDay(new Date(ex.expiresAt!))}
                        onChange={e => setExtendDay(e.target.value)}
                        className="flex-1"
                      />
                      <Button variant="primary" size="xs" onClick={() => void handleExtend(ex.id)} loading={extending} disabled={!extendDay}>
                        Save expiry
                      </Button>
                      <Button variant="secondary" size="xs" onClick={closeExtend}>
                        Cancel
                      </Button>
                    </div>
                    <ErrorAlert message={extendError} />
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
                    <Button variant="danger" size="xs" onClick={() => handleReject(ex.id)} loading={reviewingId === ex.id}>
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
            onPageChange={setOffset}
            onPageSizeChange={setLimit}
          />
        )}
        </>
      )}

      {del.target && (
        <DeleteConfirmModal
          title="Delete exemption"
          itemName={del.target.label}
          loading={del.loading}
          onCancel={del.close}
          onConfirm={() => void del.confirm()}
        />
      )}
    </div>
  );
}
