interface HelpTableProps {
  headers: string[];
  rows: string[][];
}

/** Responsive table for help content. */
export function HelpTable({ headers, rows }: HelpTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800/50">
            {headers.map((header) => (
              <th
                key={header}
                className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-4 py-2 text-gray-600 dark:text-gray-400"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
