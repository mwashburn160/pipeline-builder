import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  if (items.length <= 1) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs overflow-hidden">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        const key = item.href || item.label;
        return (
          <span key={key} className="flex items-center gap-1.5 min-w-0 shrink-0 last:shrink">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-fg-subtle shrink-0" />}
            {isLast || !item.href ? (
              <span
                className={`truncate ${isLast ? 'font-medium text-fg' : 'text-fg-muted'}`}
                aria-current={isLast ? 'page' : undefined}
              >
                {item.label}
              </span>
            ) : (
              <Link
                href={item.href}
                className="truncate text-fg-muted hover:text-fg transition-colors"
              >
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
