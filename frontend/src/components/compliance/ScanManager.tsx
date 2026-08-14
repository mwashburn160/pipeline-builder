'use client';

import { useState } from 'react';
import { Scan, Play, Square, Loader2, Eye } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { Pagination } from '@/components/ui/Pagination';
import { StatusPill } from '@/components/ui/StatusPill';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useServerPagination } from '@/hooks/useServerPagination';
import type { ComplianceScan } from '@/types/compliance';
import { SCAN_STATUS_CONFIG as STATUS_CONFIG } from '@/lib/compliance-styles';

interface ScanManagerProps {
  onViewScan?: (scanId: string) => void;
  readOnly?: boolean;
}

export default function ScanManager({ onViewScan, readOnly = false }: ScanManagerProps) {
  const toast = useToast();
  const [triggering, setTriggering] = useState(false);
  const [targetFilter, setTargetFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const {
    items: scans,
    pagination,
    loading,
    setOffset,
    refetch: fetchScans,
  } = useServerPagination<ComplianceScan, { target: string; status: string }>(
    async ({ offset, limit, filters }) => {
      const params: Record<string, string | number> = { limit, offset };
      if (filters.target) params.target = filters.target;
      if (filters.status) params.status = filters.status;
      const res = await api.getScans(params);
      if (!res.success || !res.data) {
        return { items: [], pagination: { offset, limit, total: 0 } };
      }
      return {
        items: res.data.scans,
        pagination: res.data.pagination
          ? { offset: res.data.pagination.offset, limit: res.data.pagination.limit, total: res.data.pagination.total }
          : { offset, limit, total: res.data.scans.length },
      };
    },
    { target: targetFilter, status: statusFilter },
    10,
  );

  const handlePageChange = (offset: number) => { setOffset(offset); };
  const handlePageSizeChange = (_limit: number) => { setOffset(0); };

  const handleTrigger = async (target: 'plugin' | 'pipeline' | 'all') => {
    setTriggering(true);
    try {
      await api.triggerScan(target);
      fetchScans();
    } catch (err) {
      toast.error(formatError(err, 'Failed to trigger scan'));
    } finally {
      setTriggering(false);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.cancelScan(id);
      fetchScans();
    } catch (err) {
      toast.error(formatError(err, 'Failed to cancel scan'));
    }
  };

  const columns: Column<ComplianceScan>[] = [
    {
      id: 'status',
      header: 'Status',
      render: (scan) => {
        const cfg = STATUS_CONFIG[scan.status];
        const StatusIcon = cfg.icon;
        return (
          <StatusPill gap className={`${cfg.bg} ${cfg.color}`}>
            <StatusIcon className={`h-3 w-3 ${scan.status === 'running' ? 'animate-spin' : ''}`} /> {scan.status}
          </StatusPill>
        );
      },
    },
    { id: 'target', header: 'Target', cellClassName: 'text-sm text-gray-600 dark:text-gray-400', render: (scan) => scan.target },
    {
      id: 'progress',
      header: 'Progress',
      render: (scan) => {
        const progress = scan.totalEntities > 0 ? Math.round((scan.processedEntities / scan.totalEntities) * 100) : 0;
        return (
          <div className="flex items-center gap-2">
            <div className="w-24 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-600 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-gray-500">{scan.processedEntities}/{scan.totalEntities}</span>
          </div>
        );
      },
    },
    {
      id: 'results',
      header: 'Results',
      render: (scan) => (
        <div className="flex gap-3 text-xs">
          <span className="text-green-600">{scan.passCount} pass</span>
          <span className="text-yellow-600">{scan.warnCount} warn</span>
          <span className="text-red-600">{scan.blockCount} block</span>
        </div>
      ),
    },
    { id: 'triggered', header: 'Triggered', cellClassName: 'text-xs text-gray-500', render: (scan) => new Date(scan.createdAt).toLocaleString() },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (scan) => (
        <div className="flex items-center justify-end gap-1">
          {onViewScan && (
            <IconButton tone="primary" onClick={() => onViewScan(scan.id)} title="View details" aria-label="View scan details">
              <Eye className="h-4 w-4" />
            </IconButton>
          )}
          {!readOnly && scan.status === 'running' && (
            <IconButton tone="danger" onClick={() => handleCancel(scan.id)} title="Cancel scan" aria-label="Cancel scan">
              <Square className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scan className="h-5 w-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Compliance Scans</h2>
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <Button variant="indigo" size="sm" onClick={() => handleTrigger('plugin')} disabled={triggering} className="gap-1.5">
              <Play className="h-3 w-3" /> Scan Plugins
            </Button>
            <Button variant="indigo" size="sm" onClick={() => handleTrigger('pipeline')} disabled={triggering} className="gap-1.5">
              <Play className="h-3 w-3" /> Scan Pipelines
            </Button>
            <Button variant="indigo" size="sm" onClick={() => handleTrigger('all')} disabled={triggering} className="gap-1.5">
              <Play className="h-3 w-3" /> Scan All
            </Button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <FilterSelect value={targetFilter} onChange={e => setTargetFilter(e.target.value)} aria-label="Filter scans by target">
          <option value="">All targets</option>
          <option value="plugin">Plugin</option>
          <option value="pipeline">Pipeline</option>
        </FilterSelect>
        <FilterSelect value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter scans by status">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </FilterSelect>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>
      ) : scans.length === 0 ? (
        <TextEmptyState>No scans found.</TextEmptyState>
      ) : (
        <div>
          <div className="overflow-x-auto">
            <DataTable
              data={scans}
              columns={columns}
              isLoading={false}
              getRowKey={(scan) => scan.id}
              emptyState={{ icon: Scan, title: 'No scans found', description: 'Trigger a scan to get started.' }}
            />
          </div>
          {pagination.total > pagination.limit && (
            <Pagination
              pagination={pagination}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          )}
        </div>
      )}
    </div>
  );
}
