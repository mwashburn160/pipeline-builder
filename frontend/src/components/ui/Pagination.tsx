import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

export interface PaginationState {
  limit: number;
  offset: number;
  total: number;
}

interface PaginationProps {
  pagination: PaginationState;
  onPageChange: (offset: number) => void;
  onPageSizeChange: (limit: number) => void;
  pageSizeOptions?: number[];
}

export function Pagination({
  pagination,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
}: PaginationProps) {
  const { limit, offset, total } = pagination;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(page, totalPages));
    onPageChange((clamped - 1) * limit);
  };

  const getPageNumbers = (): (number | 'ellipsis')[] => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: (number | 'ellipsis')[] = [1];
    if (currentPage > 3) pages.push('ellipsis');
    const rangeStart = Math.max(2, currentPage - 1);
    const rangeEnd = Math.min(totalPages - 1, currentPage + 1);
    for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push('ellipsis');
    if (totalPages > 1) pages.push(totalPages);
    return pages;
  };

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 px-1">
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Showing {start}–{end} of {total}
      </div>

      <div className="flex items-center gap-2">
        <select
          value={limit}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="filter-select text-xs !py-1.5 !pl-2 !pr-7"
          aria-label="Page size"
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>{size} / page</option>
          ))}
        </select>

        <nav className="flex items-center gap-0.5" aria-label="Pagination">
          <PageButton onClick={() => goToPage(1)} disabled={currentPage === 1} aria-label="First page">
            <ChevronsLeft className="w-4 h-4" />
          </PageButton>
          <PageButton onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous page">
            <ChevronLeft className="w-4 h-4" />
          </PageButton>

          {getPageNumbers().map((page, i) =>
            page === 'ellipsis' ? (
              <span key={`ellipsis-${i}`} className="px-1 text-gray-400 dark:text-gray-500 text-sm select-none">…</span>
            ) : (
              <PageButton
                key={page}
                onClick={() => goToPage(page)}
                active={page === currentPage}
                aria-label={`Page ${page}`}
              >
                {page}
              </PageButton>
            ),
          )}

          <PageButton onClick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages} aria-label="Next page">
            <ChevronRight className="w-4 h-4" />
          </PageButton>
          <PageButton onClick={() => goToPage(totalPages)} disabled={currentPage === totalPages} aria-label="Last page">
            <ChevronsRight className="w-4 h-4" />
          </PageButton>
        </nav>
      </div>
    </div>
  );
}

function PageButton({
  active,
  disabled,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`inline-flex items-center justify-center min-w-[32px] h-8 px-1.5 text-sm rounded-md transition-colors ${
        active
          ? 'bg-blue-600 text-white font-semibold'
          : disabled
            ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
            : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}
