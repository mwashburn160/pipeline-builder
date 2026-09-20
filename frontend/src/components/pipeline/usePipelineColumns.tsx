// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { AccessCell } from '@/components/ui/AccessCell';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import type { Column } from '@/components/ui/DataTable';
import { IconButton } from '@/components/ui/IconButton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import type { PipelineSummary } from '@/lib/api/domains/pipelines';

/**
 * DataTable column id → the server-side sort field the pipelines list endpoint
 * honors (via parsePaginationParams → sortBy). Columns absent here fall back to
 * their own id.
 */
export const PIPELINE_SORT_FIELD: Record<string, string> = {
  name: 'pipelineName',
  pipelineId: 'id',
  project: 'project',
  organization: 'organization',
  visibility: 'visibility',
  status: 'isActive',
  default: 'isDefault',
  createdBy: 'createdBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

interface PipelineColumnOptions {
  /** Render the leading select checkbox (bulk-capable viewers only). */
  selectable: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  /** Per-row write gate (visibility rung + `pipelines:write`). */
  canWriteRow: (pipeline: PipelineSummary) => boolean;
  onEdit: (pipeline: PipelineSummary) => void;
  onDelete: (pipeline: PipelineSummary) => void;
}

/** Columns of the pipelines catalog table. */
export function usePipelineColumns({
  selectable, selectedIds, onToggleSelect, canWriteRow, onEdit, onDelete,
}: PipelineColumnOptions): Column<PipelineSummary>[] {
  return useMemo(() => [
    ...(selectable ? [{
      id: 'select',
      header: '',
      locked: true,
      render: (pipeline: PipelineSummary) => (
        canWriteRow(pipeline) ? (
          <Checkbox
            checked={selectedIds.has(pipeline.id)}
            aria-label={`Select ${pipeline.pipelineName || pipeline.id}`}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect(pipeline.id);
            }}
          />
        ) : null
      ),
    } as Column<PipelineSummary>] : []),
    {
      id: 'name',
      header: 'Name',
      sortValue: (p) => p.pipelineName || '',
      render: (p) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* Name links to the pipeline detail; project folds in as a mono chip
                so the standalone Project column can stay hidden (see below). */}
            <Link
              href={`/dashboard/pipelines/${encodeURIComponent(p.id)}`}
              className="text-sm font-medium text-fg hover:text-brand hover:underline truncate"
            >
              {p.pipelineName}
            </Link>
            {p.project && (
              <span className="shrink-0 text-2xs font-mono text-fg-subtle border border-default rounded px-1 py-0.5">{p.project}</span>
            )}
          </div>
          {p.description && <div className="text-xs text-fg-muted truncate max-w-md mt-0.5">{p.description}</div>}
        </div>
      ),
    },
    {
      id: 'pipelineId',
      header: 'Pipeline ID',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted font-mono',
      sortValue: (p) => p.id,
      render: (p) => <>{p.id}</>,
    },
    {
      id: 'project',
      header: 'Project',
      // Hidden by default: the project shows as a chip in the Name cell, so a
      // standalone column is redundant. Re-enable via the column toggle.
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.project,
      render: (p) => <>{p.project}</>,
    },
    {
      id: 'organization',
      header: 'Organization',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.organization,
      render: (p) => <>{p.organization}</>,
    },
    {
      id: 'visibility',
      header: 'Visibility',
      sortValue: (p) => p.visibility,
      render: (p) => <AccessCell visibility={p.visibility} />,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.isActive,
      // Active (common) → subtle dot + word; Inactive (exception) → loud badge.
      render: (p) => (
        p.isActive
          ? <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted"><span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden="true" />Active</span>
          : <Badge color="red">Inactive</Badge>
      ),
    },
    {
      id: 'default',
      header: 'Default',
      hidden: true,
      sortValue: (p) => p.isDefault,
      render: (p) => p.isDefault ? <Badge color="blue">Default</Badge> : null,
    },
    {
      id: 'createdBy',
      header: 'Created by',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.createdBy,
      render: (p) => <>{p.createdBy}</>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.createdAt,
      render: (p) => <RelativeTime value={p.createdAt} />,
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.updatedAt,
      render: (p) => <RelativeTime value={p.updatedAt} />,
    },
    {
      id: 'keywords',
      header: 'Keywords',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      render: (p) => <>{(p.keywords || []).join(', ')}</>,
    },
    {
      id: 'actions',
      header: 'Actions',
      cellClassName: 'text-sm',
      render: (pipeline) => (
        canWriteRow(pipeline) ? (
          <div className="flex items-center gap-1">
            <button onClick={() => onEdit(pipeline)} className="action-link">Edit</button>
            {/* Delete as a muted icon (red only on hover, guarded by a confirm
                modal) so it doesn't sit as loud red text a click from Edit. */}
            <IconButton tone="danger" title="Delete pipeline" aria-label="Delete pipeline" onClick={() => onDelete(pipeline)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        ) : (
          <span className="text-fg-subtle text-xs">Read-only</span>
        )
      ),
    },
  ], [selectable, selectedIds, onToggleSelect, canWriteRow, onEdit, onDelete]);
}
