// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import Link from 'next/link';
import { Boxes, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { AccessCell } from '@/components/ui/AccessCell';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import type { Column } from '@/components/ui/DataTable';
import { IconButton } from '@/components/ui/IconButton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import type { PluginSummary } from '@/lib/api/domains/plugins';
import { CATEGORY_DISPLAY_NAMES, type PluginCategory } from '@/lib/plugin-categories';
import { registryHrefFor } from './PluginDetailModal';
import { pluginProducesImage } from './PluginSupplyChain';

/**
 * DataTable column id → the server-side sort field the plugins list endpoint
 * honors (via parsePaginationParams → sortBy). Columns absent here fall back to
 * their own id.
 */
export const PLUGIN_SORT_FIELD: Record<string, string> = {
  name: 'name',
  id: 'id',
  version: 'version',
  category: 'category',
  type: 'pluginType',
  compute: 'computeType',
  visibility: 'visibility',
  uri: 'uri',
  timeout: 'timeout',
  failureBehavior: 'failureBehavior',
  status: 'isActive',
  createdBy: 'createdBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

interface PluginColumnOptions {
  /** Render the leading select checkbox (bulk-capable viewers only). */
  selectable: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  favorites: Set<string>;
  onToggleFavorite: (id: string) => void;
  /** Name → number of the org's pipelines referencing the plugin. */
  usage: Record<string, number>;
  /** Per-row write gate (visibility rung + `plugins:write`). */
  canWriteRow: (plugin: PluginSummary) => boolean;
  /** Sysadmins get the registry cross-link. */
  showRegistryLink: boolean;
  onView: (plugin: PluginSummary) => void;
  onEdit: (plugin: PluginSummary) => void;
  onDelete: (plugin: PluginSummary) => void;
}

/** Columns of the plugins catalog table. */
export function usePluginColumns({
  selectable, selectedIds, onToggleSelect, favorites, onToggleFavorite, usage,
  canWriteRow, showRegistryLink, onView, onEdit, onDelete,
}: PluginColumnOptions): Column<PluginSummary>[] {
  return useMemo(() => [
    ...(selectable ? [{
      id: 'select',
      header: '',
      locked: true,
      render: (plugin: PluginSummary) => (
        canWriteRow(plugin) ? (
          <Checkbox
            checked={selectedIds.has(plugin.id)}
            aria-label={`Select ${plugin.name}`}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect(plugin.id);
            }}
          />
        ) : null
      ),
    } as Column<PluginSummary>] : []),
    {
      id: 'favorite',
      header: '',
      locked: true,
      render: (p: PluginSummary) => {
        const fav = favorites.has(p.id);
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(p.id); }}
            className={`p-1 rounded hover:bg-surface-muted ${fav ? 'text-warning' : 'text-fg-subtle hover:text-warning'}`}
            aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={fav}
            title={fav ? 'Favorited' : 'Add to favorites'}
          >
            <Star className={`w-4 h-4 ${fav ? 'fill-current' : ''}`} aria-hidden="true" />
          </button>
        );
      },
    },
    {
      id: 'name',
      header: 'Name',
      sortValue: (p) => p.name,
      render: (p) => {
        const used = usage[p.name] ?? 0;
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Name is the "view" click target (opens the detail modal), so the
                  Actions column no longer needs a separate View link. Version
                  folds in here as a chip → the standalone Version column hides. */}
              <button
                onClick={() => onView(p)}
                className="text-sm font-medium text-fg hover:text-brand hover:underline text-left truncate"
              >
                {p.name}
              </button>
              {p.version && <span className="shrink-0 text-2xs font-mono text-fg-subtle border border-default rounded px-1 py-0.5">v{p.version}</span>}
              {pluginProducesImage(p) && (p.imageDigest ? (
                <span title="Signed image" className="inline-flex text-success">
                  <ShieldCheck className="w-3.5 h-3.5" aria-label="Signed image" />
                </span>
              ) : (
                <span title="Unsigned image — rebuild or re-upload to use in pipelines" className="inline-block">
                  <Badge color="yellow">Unsigned</Badge>
                </span>
              ))}
              {!p.isActive && <Badge color="red">Inactive</Badge>}
              {used > 0 && (
                <span title={`Referenced by ${used} pipeline${used === 1 ? '' : 's'} in your org`} className="inline-block">
                  <Badge color="blue">Used by {used}</Badge>
                </span>
              )}
            </div>
            {p.description && <div className="text-xs text-fg-muted truncate max-w-md mt-0.5">{p.description}</div>}
          </div>
        );
      },
    },
    {
      id: 'id',
      header: 'ID',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted font-mono',
      sortValue: (p) => p.id,
      render: (p) => <span title={p.id}>{p.id.length > 8 ? `${p.id.slice(0, 8)}…` : p.id}</span>,
    },
    {
      id: 'version',
      header: 'Version',
      // Hidden by default: version shows as a chip in the Name cell, so a
      // standalone column (usually all "1.0.0") is redundant. Re-enable via the
      // column toggle.
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.version,
      render: (p) => <>{p.version}</>,
    },
    {
      id: 'category',
      header: 'Category',
      sortValue: (p) => p.category || 'unknown',
      render: (p) => (
        <Badge color="blue">
          {CATEGORY_DISPLAY_NAMES[(p.category || 'unknown') as PluginCategory] || p.category || 'unknown'}
        </Badge>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.pluginType,
      render: (p) => <>{p.pluginType}</>,
    },
    {
      id: 'compute',
      header: 'Compute',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.computeType,
      render: (p) => <>{p.computeType}</>,
    },
    {
      id: 'visibility',
      header: 'Visibility',
      sortValue: (p) => p.visibility,
      render: (p) => <AccessCell visibility={p.visibility} />,
    },
    {
      id: 'uri',
      header: 'URI',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted font-mono',
      sortValue: (p) => p.uri,
      render: (p) => <span title={p.uri}>{p.uri}</span>,
    },
    {
      id: 'timeout',
      header: 'Timeout',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.timeout ?? 0,
      render: (p) => <>{p.timeout ? `${p.timeout} min` : '-'}</>,
    },
    {
      id: 'failureBehavior',
      header: 'On failure',
      hidden: true,
      cellClassName: 'text-sm text-fg-muted',
      sortValue: (p) => p.failureBehavior || '',
      render: (p) => <>{p.failureBehavior || '-'}</>,
    },
    {
      id: 'status',
      header: 'Status',
      hidden: true,
      sortValue: (p) => p.isActive,
      render: (p) => (
        <div className="flex gap-1">
          {p.isDefault && <Badge color="blue">Default</Badge>}
          <Badge color={p.isActive ? 'green' : 'red'}>{p.isActive ? 'Active' : 'Inactive'}</Badge>
        </div>
      ),
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
      render: (plugin) => {
        const registryHref = showRegistryLink ? registryHrefFor(plugin.uri) : null;
        const writable = canWriteRow(plugin);
        return (
          // Decrowded: the name is the "view" target, so View is dropped. Edit
          // stays a link; registry cross-link + delete are icons (delete muted,
          // red-on-hover, guarded by the confirm modal).
          <div className="flex items-center gap-1">
            {writable && (
              <button onClick={() => onEdit(plugin)} className="action-link">Edit</button>
            )}
            {/* Sysadmin-only registry cross-link — closes the Plugins↔Registry
                navigation loop so an operator can jump straight to the image. */}
            {registryHref && (
              <Link
                href={registryHref}
                title={`Browse ${plugin.uri} in the registry`}
                aria-label="View in registry"
                className="inline-flex items-center justify-center h-8 w-8 rounded-md text-fg-subtle hover:text-brand hover:bg-info-bg transition-colors"
              >
                <Boxes className="w-4 h-4" />
              </Link>
            )}
            {writable && (
              <IconButton tone="danger" title="Delete plugin" aria-label="Delete plugin" onClick={() => onDelete(plugin)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        );
      },
    },
  ], [selectable, selectedIds, onToggleSelect, favorites, onToggleFavorite, usage, canWriteRow, showRegistryLink, onView, onEdit, onDelete]);
}
