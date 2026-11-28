import { TableIcon } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui/DataTable';

interface HelpTableProps {
  headers: string[];
  rows: string[][];
}

/** Responsive table for help content. */
export function HelpTable({ headers, rows }: HelpTableProps) {
  const columns: Column<string[]>[] = headers.map((header, j) => ({
    id: `${header}-${j}`,
    header,
    headerClassName: 'whitespace-nowrap',
    cellClassName: 'text-fg-muted',
    render: (row) => row[j],
  }));

  return (
    // A wide table scrolls sideways inside DataTable's own scroller, which is
    // made a named, focusable region so the keyboard can scroll it too (axe
    // scrollable-region-focusable, WCAG 2.1.1).
    <DataTable
      data={rows}
      columns={columns}
      isLoading={false}
      animated={false}
      // The first cell is, in practice, the row's natural identifier
      // (column name, env-var name, etc.) — preferable to the raw index.
      getRowKey={(row, i) => `${row[0] ?? ''}-${i}`}
      emptyState={{ icon: TableIcon, title: 'No data', description: 'No rows to display.' }}
      scrollRegionLabel={`Table: ${headers.join(', ')}`}
    />
  );
}
