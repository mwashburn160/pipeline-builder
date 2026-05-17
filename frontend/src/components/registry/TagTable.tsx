// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Copy, Trash2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';

interface TagTableProps {
  repo: string;
  tags: string[] | null;
  loading: boolean;
  error: Error | null;
  selectedTag: string | null;
  onSelect: (tag: string) => void;
  onCopy: (tag: string) => void;
  onDelete: (tag: string) => void;
  onRefresh: () => void;
  /** Optional metadata for each tag — multi-arch, digest, etc. Populated lazily. */
  metadata?: Map<string, { isMultiArch: boolean; digestShort: string; created?: string }>;
}

/**
 * Middle-pane tag table for the currently-selected repo. Renders one row
 * per tag with View / Copy / Delete actions. Multi-arch tags carry a
 * "multi-arch" badge; the created date comes from each tag's config blob
 * (loaded lazily by the page so this component is render-only).
 */
export function TagTable({
  repo, tags, loading, error, selectedTag, onSelect, onCopy, onDelete, onRefresh, metadata,
}: TagTableProps) {
  const [filter, setFilter] = useState('');

  const filtered = (tags ?? [])
    .filter((t) => !filter || t.toLowerCase().includes(filter.toLowerCase()))
    .sort();

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate" title={repo}>
          {repo}
        </div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tags…"
          className="ml-auto w-48 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh tags"
          className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-3 p-3 text-sm border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 rounded">
            <div className="font-medium mb-1">Failed to load tags</div>
            <div className="text-xs mb-2">{error.message}</div>
            <button onClick={onRefresh} className="text-xs underline">Retry</button>
          </div>
        )}

        {!error && filtered.length === 0 && !loading && (
          <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
            {tags === null || tags.length === 0
              ? 'No tags in this repository.'
              : 'No tags match the filter.'}
          </div>
        )}

        {filtered.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Tag</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Digest</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Created</th>
                <th className="text-right px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tag) => {
                const meta = metadata?.get(tag);
                return (
                  <tr
                    key={tag}
                    className={`border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 ${
                      selectedTag === tag ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <button
                        onClick={() => onSelect(tag)}
                        className="text-left text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs"
                      >
                        {tag}
                      </button>
                      {meta?.isMultiArch && (
                        <Badge color="purple" className="ml-2">multi-arch</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {meta?.digestShort ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                      {meta?.isMultiArch
                        ? '—'
                        : meta?.created
                          ? new Date(meta.created).toLocaleDateString()
                          : '—'}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => onCopy(tag)}
                        title="Copy tag…"
                        className="p-1 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => onDelete(tag)}
                        title="Delete tag"
                        className="p-1 text-gray-500 hover:text-red-600 dark:hover:text-red-400"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
