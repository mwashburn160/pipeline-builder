'use client';

import { useState } from 'react';
import { CalendarClock, Plus, Pencil, Trash2, Loader2, X } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useDelete } from '@/hooks/useDelete';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { useToast } from '@/components/ui/Toast';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { ScanSchedule } from '@/types/compliance';
import { formatDateTime } from '@/lib/format';
import { formatError } from '@/lib/constants';
import { LoadingSpinner } from '@/components/ui/Loading';

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
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<ScanScheduleFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const { data, loading, refetch: fetchSchedules } = useFetch<ScanSchedule[]>(
    async () => (await api.getScanSchedules()).data?.schedules ?? [],
    [],
    { onError: (err) => toast.error(formatError(err, 'Failed to load scan schedules')) },
  );
  const schedules = data ?? [];

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
      void fetchSchedules();
    } catch (err) {
      toast.error(formatError(err, `Failed to ${editingId ? 'update' : 'create'} schedule`));
    }
    setSubmitting(false);
  };

  const handleToggle = async (schedule: ScanSchedule) => {
    setTogglingId(schedule.id);
    try {
      await api.toggleScanScheduleActive(schedule.id, !schedule.isActive);
      void fetchSchedules();
    } catch (err) {
      toast.error(formatError(err, 'Failed to toggle schedule'));
    }
    setTogglingId(null);
  };

  // `useDelete` owns the step-up replay: a delete refused pending re-auth
  // completes and refreshes once the person confirms in the global dialog.
  const del = useDelete<ScanSchedule>(
    (schedule) => api.deleteScanSchedule(schedule.id),
    () => { toast.success('Schedule deleted'); void fetchSchedules(); },
    (err) => toast.error(formatError(err, 'Failed to delete schedule')),
  );
  const deletingId = del.loading ? del.target?.id : undefined;

  const columns: Column<ScanSchedule>[] = [
    { id: 'target', header: 'Target', cellClassName: 'text-sm text-fg-muted capitalize', render: (s) => s.target },
    {
      id: 'cron',
      header: 'Cron expression',
      render: (s) => (
        <code className="text-sm bg-surface-muted px-2 py-0.5 rounded text-fg">{s.cronExpression}</code>
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
            ? <Loader2 className="w-4 h-4 animate-spin text-fg-subtle" />
            : <Badge color={s.isActive ? 'green' : 'gray'}>{s.isActive ? 'Active' : 'Inactive'}</Badge>}
        </button>
      ),
    },
    { id: 'lastRun', header: 'Last run', cellClassName: 'text-xs text-fg-muted', render: (s) => formatDateTime(s.lastRunAt) },
    { id: 'nextRun', header: 'Next run', cellClassName: 'text-xs text-fg-muted', render: (s) => formatDateTime(s.nextRunAt) },
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
          <Button variant="danger" size="xs" onClick={() => del.open(s)} disabled={deletingId === s.id} title="Delete schedule" aria-label="Delete schedule">
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
          <CalendarClock className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="text-lg font-semibold text-fg">Scan schedules</h2>
        </div>
        {!readOnly && (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> New Schedule
          </Button>
        )}
      </div>

      {/* Inline form */}
      {showForm && (
        <div className="rounded-lg border border-default bg-surface p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-fg">
              {editingId ? 'Edit Schedule' : 'Create Schedule'}
            </h3>
            <button onClick={closeForm} aria-label="Close" className="p-1 rounded-lg text-fg-subtle hover:text-fg">
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <div className="flex-1">
              <label htmlFor="scan-schedule-target" className="block text-xs font-medium text-fg-muted mb-1">Target</label>
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
              <label htmlFor="scan-schedule-cron" className="block text-xs font-medium text-fg-muted mb-1">Cron expression</label>
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
        <div className="flex items-center justify-center py-12"><LoadingSpinner label="Loading scan schedules" /></div>
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
      {del.target && (
        <DeleteConfirmModal
          title="Delete scan schedule"
          itemName={`${del.target.target} schedule (${del.target.cronExpression})`}
          loading={del.loading}
          onConfirm={() => void del.confirm()}
          onCancel={del.close}
        />
      )}
    </div>
  );
}
