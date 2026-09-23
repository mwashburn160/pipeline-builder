// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { CATEGORY_DESCRIPTIONS, CATEGORY_DISPLAY_NAMES, PLUGIN_CATEGORIES, isPluginCategory } from '@/lib/plugin-categories';
import { categoryPagePath, pluginPagePath } from '@/lib/public-directory/links';
import type { CategorySummary } from '@/lib/public-directory/types';
import { CategoryTile } from './PluginIcon';
import { Card } from '@/components/ui/Card';

/**
 * The directory's category grid: glyph, description, a LIVE count (from the
 * API, never hard-coded) and the top three plugins. Categories render in the
 * canonical order; one the API doesn't report shows with a zero count rather
 * than disappearing, so the grid is stable.
 */
export function CategoryGrid({ categories }: { categories: CategorySummary[] }) {
  const byId = new Map(categories.filter((c) => isPluginCategory(c.id)).map((c) => [c.id, c]));
  return (
    <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
      {PLUGIN_CATEGORIES.map((id) => {
        const summary = byId.get(id);
        const count = summary?.count ?? 0;
        return (
          <Card as="li" key={id} className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-3">
              <CategoryTile category={id} size="sm" />
              <h3 className="flex-1 text-base font-semibold text-fg">
                <Link href={categoryPagePath(id)} className="hover:underline">{CATEGORY_DISPLAY_NAMES[id]}</Link>
              </h3>
              <span className="text-xs tabular-nums text-fg-subtle">
                {count} {count === 1 ? 'plugin' : 'plugins'}
              </span>
            </div>
            <p className="text-sm text-fg-muted">{CATEGORY_DESCRIPTIONS[id]}</p>
            {summary && summary.top.length > 0 && (
              <ul className="mt-auto flex flex-wrap gap-1.5" aria-label={`Top ${CATEGORY_DISPLAY_NAMES[id]} plugins`}>
                {summary.top.slice(0, 3).map((p) => (
                  <li key={`${p.publisher.handle}/${p.name}`}>
                    <Link
                      href={pluginPagePath(p.publisher.handle, p.name)}
                      className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-xs text-fg-muted hover:text-fg"
                    >
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </ul>
  );
}
