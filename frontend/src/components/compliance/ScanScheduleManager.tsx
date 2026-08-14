'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { CalendarClock, Plus, Pencil, Trash2, Loader2, X } from 'lucide-react';
import api from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { useToast } from '@/components/ui/Toast';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { ScanSchedule } from '@/types/compliance';

interface ScanScheduleFormData {
  target: string;
  cronExpression: string;
}

const EMPTY_FORM: ScanScheduleFormData = { target: 'all', cronExpression: '0 0 * * *' };

interface ScanScheduleManagerProps {
  readOnly?: boolean;
}

export default function ScanScheduleManager({ readOnly = false }: ScanScheduleManagerProps) {
  const toast = useToast();
  const [schedules, setSchedules] = useState<ScanSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<ScanScheduleFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScanSchedule | null>(null);

  // Stale-response guard: skip setState if a newer fetch started or the
  // component unmounted while this request was in flight.
  const genRef = useRef(0);

  const fetchSchedules = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    try {
      const res = await api.getScanSchedules();
      if (gen !== genRef.current) return;
      if (res.success && res.data) {
        setSchedules(res.data.schedules);
      }
    } catch (err) {
      if (gen !== genRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Failed to load scan schedules');
    }
    if (gen === genRef.current) setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchSchedules();
    return () => { genRef.current++; };
  }, [fetchSchedules]);

  const openCreate = () => {
    setEditingId(null);
    setFormData(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (schedule: ScanSchedule) => {
    setEditingId(schedule.id);
    setFormData({ target: schedule.target, cronExpression: schedule.cronExpression });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setFormData(EMPTY_FORM);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (editingId) {
        await api.updateScanSchedule(editingId, formData);
        toast.success('Schedule updated');
      } else {
        await api.createScanSchedule(formData);
        toast.success('Schedule created');
      }
      closeForm();
      fetchSchedules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${editingId ? 'update' : 'create'} schedule`);
    }
    setSubmitting(false);
  };

  const handleToggle = async (schedule: ScanSchedule) => {
    setTogglingId(schedule.id);
    try {
      await api.toggleScanScheduleActive(schedule.id, !schedule.isActive);
      fetchSchedules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle schedule');
    }
    setTogglingId(null);
  };

  const performDelete = async (schedule: ScanSchedule) => {
    setDeletingId(schedule.id);
    setConfirmDelete(null);
    try {
      await api.deleteScanSchedule(schedule.id);
      toast.success('Schedule deleted');
      fetchSchedules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete schedule');
    }
    setDeletingId(null);
  };

  const columns: Column<ScanSchedule>[] = [
    { id: 'target', header: 'Target', cellClassName: 'text-sm text-gray-600 dark:text-gray-400 capitalize', render: (s) => s.target },
    {
      id: 'cron',
      header: 'Cron Expression',
      render: (s) => (
        <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-gray-800 dark:text-gray-200">{s.cronExpression}</code>
      ),
    },
    {
      id: 'active',
      header: 'Active',
      render: (s) => (
        <button
          onClick={() => handleToggle(s)}
          disabled={readOnly || togglingId === s.id}
          className="focus:outline-none disabled:opacity-50"
          title={s.isActive ? 'Deactivate' : 'Activate'}
          aria-label={s.isActive ? 'Deactivate schedule' : 'Activate schedule'}
        >
          {togglingId === s.id
            ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
            : <Badge color={s.isActive ? 'green' : 'gray'}>{s.isActive ? 'Active' : 'Inactive'}</Badge>}
        </button>
      ),
    },
    { id: 'lastRun', header: 'Last Run', cellClassName: 'text-xs text-gray-500', render: (s) => (s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '--') },
    { id: 'nextRun', header: 'Next Run', cellClassName: 'text-xs text-gray-500', render: (s) => (s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '--') },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (s) => (!readOnly ? (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="xs" onClick={() => openEdit(s)} title="Edit schedule" aria-label="Edit schedule">
            <Pencil className="w-4 h-4" />
          </Button>
          <Button variant="danger" size="xs" onClick={() => setConfirmDelete(s)} disabled={deletingId === s.id} title="Delete schedule" aria-label="Delete schedule">
            {deletingId === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </Button>
        </div>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Scan Schedules</h2>
        </div>
        {!readOnly && (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> New Schedule
          </Button>
        )}
      </div>

      {/* Inline form */}
      {showForm && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {editingId ? 'Edit Schedule' : 'Create Schedule'}
            </h3>
            <button onClick={closeForm} aria-label="Close" className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <div className="flex-1">
              <label htmlFor="scan-schedule-target" className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Target</label>
              <FilterSelect
                id="scan-schedule-target"
                value={formData.target}
                onChange={e => setFormData(prev => ({ ...prev, target: e.target.value }))}
              >
                <option value="all">All</option>
                <option value="plugin">Plugin</option>
                <option value="pipeline">Pipeline</option>
              </FilterSelect>
            </div>
            <div className="flex-[2]">
              <label htmlFor="scan-schedule-cron" className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Cron Expression</label>
              <Input
                id="scan-schedule-cron"
                type="text"
                value={formData.cronExpression}
                onChange={e => setFormData(prev => ({ ...prev, cronExpression: e.target.value }))}
                placeholder="0 0 * * *"
                aria-label="Cron expression"
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" loading={submitting}>
                {editingId ? 'Update' : 'Create'}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>
      ) : schedules.length === 0 ? (
        <TextEmptyState>No scan schedules found.</TextEmptyState>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            data={schedules}
            columns={columns}
            isLoading={false}
            getRowKey={(s) => s.id}
            emptyState={{ icon: CalendarClock, title: 'No scan schedules', description: 'Create one to run scans automatically.' }}
          />
        </div>
      )}
      {confirmDelete && (
        <DeleteConfirmModal
          title="Delete scan schedule"
          itemName={`${confirmDelete.target} schedule (${confirmDelete.cronExpression})`}
          loading={deletingId === confirmDelete.id}
          onConfirm={() => performDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
