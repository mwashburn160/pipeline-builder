import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { PLUGIN_CATALOG, PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/help';
import type { PluginCategory } from '@/lib/help';

/** Searchable, filterable plugin catalog table. */
export function PluginCatalog() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return PLUGIN_CATALOG.filter((p) => {
      if (category && p.category !== category) return false;
      if (q && !p.name.includes(q) && !p.description.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [search, category]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins..."
            className="input pl-9 text-sm w-full"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="input text-sm sm:w-48"
        >
          <option value="">All Categories</option>
          {PLUGIN_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{CATEGORY_DISPLAY_NAMES[cat]}</option>
          ))}
        </select>
      </div>

      {/* Results count */}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {filtered.length} plugin{filtered.length !== 1 ? 's' : ''} found
      </p>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800/50">
              <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Name</th>
              <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Category</th>
              <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300 hidden sm:table-cell">Description</th>
              <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Secrets</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {filtered.map((plugin) => (
              <tr key={plugin.name} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-2 text-gray-900 dark:text-gray-100 font-mono text-xs">{plugin.name}</td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    {CATEGORY_DISPLAY_NAMES[plugin.category as PluginCategory] || plugin.category}
                  </span>
                </td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-400 hidden sm:table-cell">{plugin.description}</td>
                <td className="px-4 py-2 text-gray-500 dark:text-gray-400 font-mono text-xs">
                  {plugin.secrets.length > 0 ? plugin.secrets.join(', ') : '—'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                  No plugins match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
