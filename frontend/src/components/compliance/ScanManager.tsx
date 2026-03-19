'use client';

import { useState, useEffect, useCallback } from 'react';
import { Scan, Play, Square, Loader2, CheckCircle, XCircle, Clock, Eye } from 'lucide-react';
import api from '@/lib/api';
import type { ComplianceScan, ScanStatus } from '@/types/compliance';

const STATUS_CONFIG: Record<ScanStatus, { icon: typeof CheckCircle; color: string; bg: string }> = {
  pending: { icon: Clock, color: 'text-yellow-600', bg: 'bg-yellow-100 dark:bg-yellow-900/30' },
  running: { icon: Loader2, color: 'text-blue-600', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  completed: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-100 dark:bg-green-900/30' },
  failed: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-100 dark:bg-red-900/30' },
  cancelled: { icon: Square, color: 'text-gray-500', bg: 'bg-gray-100 dark:bg-gray-700' },
};

interface ScanManagerProps {
  onViewScan?: (scanId: string) => void;
  readOnly?: boolean;
}

export default function ScanManager({ onViewScan, readOnly = false }: ScanManagerProps) {
  const [scans, setScans] = useState<ComplianceScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [targetFilter, setTargetFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchScans = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit: 20 };
      if (targetFilter) params.target = targetFilter;
      if (statusFilter) params.status = statusFilter;
      const res = await api.getScans(params);
      if (res.success && res.data) setScans(res.data.scans);
    } catch { /* handled by loading state */ }
    setLoading(false);
  }, [targetFilter, statusFilter]);

  useEffect(() => { fetchScans(); }, [fetchScans]);

  const handleTrigger = async (target: 'plugin' | 'pipeline' | 'all') => {
    setTriggering(true);
    try {
      await api.triggerScan(target);
      fetchScans();
    } catch { /* handled */ }
    setTriggering(false);
  };

  const handleCancel = async (id: string) => {
    await api.cancelScan(id);
    fetchScans();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scan className="h-5 w-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Compliance Scans</h2>
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <button onClick={() => handleTrigger('plugin')} disabled={triggering} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              <Play className="h-3 w-3" /> Scan Plugins
            </button>
            <button onClick={() => handleTrigger('pipeline')} disabled={triggering} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              <Play className="h-3 w-3" /> Scan Pipelines
            </button>
            <button onClick={() => handleTrigger('all')} disabled={triggering} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-800 text-white rounded-lg hover:bg-indigo-900 disabled:opacity-50">
              <Play className="h-3 w-3" /> Scan All
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <select value={targetFilter} onChange={e => setTargetFilter(e.target.value)} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm">
          <option value="">All targets</option>
          <option value="plugin">Plugin</option>
          <option value="pipeline">Pipeline</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>
      ) : scans.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">No scans found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Target</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Progress</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Results</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Triggered</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
              {scans.map(scan => {
                const cfg = STATUS_CONFIG[scan.status];
                const StatusIcon = cfg.icon;
                const progress = scan.totalEntities > 0 ? Math.round((scan.processedEntities / scan.totalEntities) * 100) : 0;
                return (
                  <tr key={scan.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.color}`}>
                        <StatusIcon className={`h-3 w-3 ${scan.status === 'running' ? 'animate-spin' : ''}`} /> {scan.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{scan.target}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-600 rounded-full transition-all" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="text-xs text-gray-500">{scan.processedEntities}/{scan.totalEntities}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-3 text-xs">
                        <span className="text-green-600">{scan.passCount} pass</span>
                        <span className="text-yellow-600">{scan.warnCount} warn</span>
                        <span className="text-red-600">{scan.blockCount} block</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{new Date(scan.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {onViewScan && (
                          <button onClick={() => onViewScan(scan.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20" title="View details" aria-label="View scan details">
                            <Eye className="h-4 w-4" />
                          </button>
                        )}
                        {!readOnly && scan.status === 'running' && (
                          <button onClick={() => handleCancel(scan.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="Cancel scan" aria-label="Cancel scan">
                            <Square className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
