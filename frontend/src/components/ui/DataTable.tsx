import { useState, useMemo, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { LoadingSpinner } from './Loading';
import { EmptyState } from './EmptyState';

export interface Column<T> {
  id: string;
  header: string;
  headerClassName?: string;
  cellClassName?: string;
  render: (item: T, index: number) => ReactNode;
  sortValue?: (item: T) => string | number | boolean | Date | null | undefined;
  hidden?: boolean;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  isLoading: boolean;
  emptyState: {
    icon: LucideIcon;
    title: string;
    description: string;
    action?: ReactNode;
  };
  getRowKey?: (item: T, index: number) => string;
  animated?: boolean;
  animationDelay?: number;
  maxAnimationDelay?: number;
  defaultSortColumn?: string;
  defaultSortDirection?: 'asc' | 'desc';
}

interface SortState {
  columnId: string | null;
  direction: 'asc' | 'desc';
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? -1 : 1;
  }
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

export function DataTable<T>({
  data,
  columns,
  isLoading,
  emptyState,
  getRowKey,
  animated = true,
  animationDelay = 0.03,
  maxAnimationDelay,
  defaultSortColumn,
  defaultSortDirection = 'asc',
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>({
    columnId: defaultSortColumn ?? null,
    direction: defaultSortDirection,
  });

  const visibleColumns = useMemo(
    () => columns.filter((c) => !c.hidden),
    [columns],
  );

  const sortedData = useMemo(() => {
    if (!sort.columnId) return data;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col?.sortValue) return data;
    const accessor = col.sortValue;
    return [...data].sort((a, b) => {
      const result = compare(accessor(a), accessor(b));
      return sort.direction === 'asc' ? result : -result;
    });
  }, [data, sort, columns]);

  const handleSort = (columnId: string) => {
    setSort((prev) => ({
      columnId,
      direction: prev.columnId === columnId && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (sortedData.length === 0) {
    return <EmptyState {...emptyState} />;
  }

  return (
    <div className="data-table">
      <table className="min-w-full">
        <thead>
          <tr>
            {visibleColumns.map((col) => {
              const sortable = !!col.sortValue;
              const sorted = sort.columnId === col.id;

              return (
                <th
                  key={col.id}
                  className={col.headerClassName}
                  aria-sort={sorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                      onClick={() => handleSort(col.id)}
                    >
                      {col.header}
                      {sorted ? (
                        sort.direction === 'asc' ? (
                          <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowDown className="w-3 h-3" />
                        )
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((item, i) => {
            const delay = maxAnimationDelay
              ? Math.min(i * animationDelay, maxAnimationDelay)
              : i * animationDelay;

            const key = getRowKey ? getRowKey(item, i) : String(i);

            return animated ? (
              <motion.tr
                key={key}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay }}
              >
                {visibleColumns.map((col) => (
                  <td key={col.id} className={col.cellClassName}>
                    {col.render(item, i)}
                  </td>
                ))}
              </motion.tr>
            ) : (
              <tr key={key}>
                {visibleColumns.map((col) => (
                  <td key={col.id} className={col.cellClassName}>
                    {col.render(item, i)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
