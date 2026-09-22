// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Help-center pointer to the live public plugin directory, replacing the old
 * hand-kept catalog table (which drifted from the real catalog). One link per
 * category, with its glyph and description.
 */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { CATEGORY_DESCRIPTIONS, CATEGORY_DISPLAY_NAMES, PLUGIN_CATEGORIES } from '@/lib/plugin-categories';
import { CATEGORY_ICONS } from '@/lib/plugin-category-icons';
import { categoryPagePath } from '@/lib/public-directory/links';

export function PluginDirectoryLinks() {
  return (
    <div className="mt-3 space-y-3">
      <Link href="/plugins" className="action-link inline-flex items-center gap-1">
        Open the plugin directory <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <ul className="grid gap-2 sm:grid-cols-2">
        {PLUGIN_CATEGORIES.map((id) => {
          const Glyph = CATEGORY_ICONS[id];
          return (
            <li key={id}>
              <Link
                href={categoryPagePath(id)}
                className="flex items-start gap-2 rounded-lg border border-default p-2 transition-colors hover:bg-surface-muted"
              >
                <Glyph className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">{CATEGORY_DISPLAY_NAMES[id]}</span>
                  <span className="block text-xs text-fg-muted">{CATEGORY_DESCRIPTIONS[id]}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
