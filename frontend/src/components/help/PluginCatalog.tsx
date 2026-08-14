import { useState, useMemo } from 'react';
import { Search, Puzzle } from 'lucide-react';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { PLUGIN_CATALOG, PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/help';
import type { PluginCategory } from '@/lib/help';

type CatalogEntry = typeof PLUGIN_CATALOG[number];

const CATALOG_COLUMNS: Column<CatalogEntry>[] = [
  { id: 'name', header: 'Name', cellClassName: 'text-gray-900 dark:text-gray-100 font-mono text-xs', render: (p) => p.name },
  {
    id: 'category',
    header: 'Category',
    render: (p) => (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
        {CATEGORY_DISPLAY_NAMES[p.category as PluginCategory] || p.category}
      </span>
    ),
  },
  { id: 'description', header: 'Description', headerClassName: 'hidden sm:table-cell', cellClassName: 'hidden sm:table-cell text-gray-600 dark:text-gray-400', render: (p) => p.description },
  { id: 'secrets', header: 'Secrets', cellClassName: 'text-gray-500 dark:text-gray-400 font-mono text-xs', render: (p) => (p.secrets.length > 0 ? p.secrets.join(', ') : '—') },
];

/** Searchable, filterable plugin catalog table. */
export function PluginCatalog() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return PLUGIN_CATALOG.filter((p) => {
      if (category && p.category !== category) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [search, category]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <FilterInput
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins..."
            aria-label="Search plugins"
          />
        </div>
        <FilterSelect
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
          className="sm:w-48"
        >
          <option value="">All Categories</option>
          {PLUGIN_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{CATEGORY_DISPLAY_NAMES[cat]}</option>
          ))}
        </FilterSelect>
      </div>

      {/* Results count */}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {filtered.length} plugin{filtered.length !== 1 ? 's' : ''} found
      </p>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <DataTable
          data={filtered}
          columns={CATALOG_COLUMNS}
          isLoading={false}
          animated={false}
          getRowKey={(plugin) => plugin.name}
          emptyState={{ icon: Puzzle, title: 'No plugins', description: 'No plugins match your search.' }}
        />
      </div>
    </div>
  );
}
