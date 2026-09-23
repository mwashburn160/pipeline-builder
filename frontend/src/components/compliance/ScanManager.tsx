'use client';

import { useState } from 'react';
import { Scan, Play, Square, Eye } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
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
import { formatDateTime } from '@/lib/format';
import { LoadingSpinner } from '@/components/ui/Loading';

interface ScanManagerProps {
  onViewScan?: (scanId: string) => void;
  readOnly?: boolean;
}

export default function ScanManager({ onViewScan, readOnly = false }: ScanManagerProps) {
  const toast = useToast();
  const [triggering, setTriggering] = useState(false);
  const [targetFilter, setTargetFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [triggeredByFilter, setTriggeredByFilter] = useState('');
  // A running scan awaiting the "stop it?" confirmation, and whether that stop
  // is in flight.
  const [cancelTarget, setCancelTarget] = useState<ComplianceScan | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const {
    items: scans,
    pagination,
    loading,
    setOffset,
    refetch: fetchScans,
  } = useServerPagination<ComplianceScan, { target: string; status: string; triggeredBy: string }>(
    async ({ offset, limit, filters }) => {
      const params: Record<string, string | number> = { limit, offset };
      if (filters.target) params.target = filters.target;
      if (filters.status) params.status = filters.status;
      if (filters.triggeredBy) params.triggeredBy = filters.triggeredBy;
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
    { target: targetFilter, status: statusFilter, triggeredBy: triggeredByFilter },
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

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await api.cancelScan(cancelTarget.id);
      setCancelTarget(null);
      fetchScans();
    } catch (err) {
      toast.error(formatError(err, 'Failed to cancel scan'));
    } finally {
      setCancelling(false);
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
    { id: 'target', header: 'Target', cellClassName: 'text-sm text-fg-muted', render: (scan) => scan.target },
    {
      id: 'progress',
      header: 'Progress',
      render: (scan) => {
        const progress = scan.totalEntities > 0 ? Math.round((scan.processedEntities / scan.totalEntities) * 100) : 0;
        return (
          <div className="flex items-center gap-2">
            <div className="w-24 h-2 bg-surface-muted rounded-full overflow-hidden">
              <div className="h-full bg-indigo-600 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-fg-muted">{scan.processedEntities}/{scan.totalEntities}</span>
          </div>
        );
      },
    },
    {
      id: 'results',
      header: 'Results',
      render: (scan) => (
        <div className="flex gap-3 text-xs">
          <span className="text-success">{scan.passCount} pass</span>
          <span className="text-warning">{scan.warnCount} warn</span>
          <span className="text-danger">{scan.blockCount} block</span>
        </div>
      ),
    },
    { id: 'triggered', header: 'Triggered', cellClassName: 'text-xs text-fg-muted', render: (scan) => formatDateTime(scan.createdAt) },
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
            <IconButton tone="danger" onClick={() => setCancelTarget(scan)} title="Cancel scan" aria-label="Cancel scan">
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
          <Scan className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="text-lg font-semibold text-fg">Compliance scans</h2>
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
        <FilterSelect value={triggeredByFilter} onChange={e => setTriggeredByFilter(e.target.value)} aria-label="Filter scans by trigger">
          <option value="">All triggers</option>
          <option value="manual">Manual</option>
          <option value="scheduled">Scheduled</option>
          <option value="rule-change">Rule change</option>
          <option value="rule-dry-run">Rule dry run</option>
        </FilterSelect>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><LoadingSpinner label="Loading scans" /></div>
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

      {cancelTarget && (
        <ConfirmDialog
          title="Cancel this scan?"
          confirmLabel="Cancel scan"
          cancelLabel="Keep running"
          tone="danger"
          loading={cancelling}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelTarget(null)}
        >
          <p>
            The {cancelTarget.target} scan stops where it is ({cancelTarget.processedEntities}/{cancelTarget.totalEntities} checked).
            Entities it hasn&apos;t reached won&apos;t be evaluated, and it can&apos;t be resumed — start a new scan to cover them.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
