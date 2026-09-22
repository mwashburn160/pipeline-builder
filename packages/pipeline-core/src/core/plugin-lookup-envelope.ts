// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from '@pipeline-builder/pipeline-data';

/**
 * Unwrap a `/plugins/lookup` answer. The platform's success envelope is
 * `{ success, statusCode, data: { plugin, warnings } }` (note the double
 * nesting: `data.plugin`); `{ data: Plugin }`, `{ plugin }` and a bare Plugin
 * are tolerated too. Returns the plugin (null when absent or nameless) and the
 * lifecycle warning messages (deprecated / yanked-but-pinned) that ride beside it.
 *
 * Dependency-free (type-only imports) so the plugin-lookup Lambda can bundle it.
 */
export function unwrapLookup(body: unknown): { plugin: Plugin | null; warnings: string[] } {
  if (!body || typeof body !== 'object') return { plugin: null, warnings: [] };
  const inner = (body as { data?: unknown }).data;
  const container = (inner && typeof inner === 'object' ? inner : body) as { plugin?: unknown; warnings?: unknown };
  const candidate = container.plugin ?? container;
  const plugin = candidate && typeof candidate === 'object' && typeof (candidate as { name?: unknown }).name === 'string'
    && (candidate as { name: string }).name.length > 0
    ? candidate as Plugin
    : null;
  const warnings = Array.isArray(container.warnings)
    ? container.warnings
      .map((w) => (w && typeof w === 'object' ? (w as { message?: unknown }).message : undefined))
      .filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];
  return { plugin, warnings };
}
