'use client';

import { useState, useEffect, useCallback } from 'react';
import { CalendarClock, Plus, Pencil, Trash2, Loader2, X } from 'lucide-react';
import api from '@/lib/api';
import { Badge } from '@/components/ui/Badge';

interface ScanSchedule {
  id: string;
  target: string;
  cronExpression: string;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScanScheduleFormData {
  target: string;
  cronExpression: string;
}

const EMPTY_FORM: ScanScheduleFormData = { target: 'all', cronExpression: '0 0 * * *' };

interface ScanScheduleManagerProps {
  readOnly?: boolean;
}

export default function ScanScheduleManager({ readOnly = false }: ScanScheduleManagerProps) {
  const [schedules, setSchedules] = useState<ScanSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<ScanScheduleFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getScanSchedules();
      if (res.success && res.data) {
        setSchedules(res.data.schedules as unknown as ScanSchedule[]);
      }
    } catch { /* handled by loading state */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSchedules(); }, [fetchSchedules]);

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
      } else {
        await api.createScanSchedule(formData);
      }
      closeForm();
      fetchSchedules();
    } catch { /* handled */ }
    setSubmitting(false);
  };

  const handleToggle = async (schedule: ScanSchedule) => {
    setTogglingId(schedule.id);
    try {
      await api.toggleScanScheduleActive(schedule.id, !schedule.isActive);
      fetchSchedules();
    } catch { /* handled */ }
    setTogglingId(null);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this scan schedule?')) return;
    setDeletingId(id);
    try {
      await api.deleteScanSchedule(id);
      fetchSchedules();
    } catch { /* handled */ }
    setDeletingId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Scan Schedules</h2>
        </div>
        {!readOnly && (
          <button onClick={openCreate} className="btn btn-primary">
            <Plus className="w-4 h-4" /> New Schedule
          </button>
        )}
      </div>

      {/* Inline form */}
      {showForm && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {editingId ? 'Edit Schedule' : 'Create Schedule'}
            </h3>
            <button onClick={closeForm} className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Target</label>
              <select
                value={formData.target}
                onChange={e => setFormData(prev => ({ ...prev, target: e.target.value }))}
                className="filter-select"
              >
                <option value="all">All</option>
                <option value="plugin">Plugin</option>
                <option value="pipeline">Pipeline</option>
              </select>
            </div>
            <div className="flex-[2]">
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Cron Expression</label>
              <input
                type="text"
                value={formData.cronExpression}
                onChange={e => setFormData(prev => ({ ...prev, cronExpression: e.target.value }))}
                placeholder="0 0 * * *"
                required
                className="input"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={closeForm} className="btn btn-secondary">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="btn btn-primary">
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingId ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>
      ) : schedules.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">No scan schedules found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Target</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cron Expression</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Active</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Run</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Next Run</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
              {schedules.map(schedule => (
                <tr key={schedule.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 capitalize">{schedule.target}</td>
                  <td className="px-4 py-3">
                    <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-gray-800 dark:text-gray-200">
                      {schedule.cronExpression}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggle(schedule)}
                      disabled={readOnly || togglingId === schedule.id}
                      className="focus:outline-none disabled:opacity-50"
                      title={schedule.isActive ? 'Deactivate' : 'Activate'}
                      aria-label={schedule.isActive ? 'Deactivate schedule' : 'Activate schedule'}
                    >
                      {togglingId === schedule.id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                      ) : (
                        <Badge color={schedule.isActive ? 'green' : 'gray'}>
                          {schedule.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : '--'}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '--'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!readOnly && (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(schedule)}
                          className="btn btn-ghost btn-xs"
                          title="Edit schedule"
                          aria-label="Edit schedule"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(schedule.id)}
                          disabled={deletingId === schedule.id}
                          className="btn btn-danger btn-xs"
                          title="Delete schedule"
                          aria-label="Delete schedule"
                        >
                          {deletingId === schedule.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
