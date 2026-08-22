// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Display label for a support alias — strips the `@domain` suffix so the
 * configured `SUPPORT_ALIASES` render as their local-parts.
 * `"support@pipeline-builder"` → `"support"`, `"help@pipeline-builder"` → `"help"`.
 * Replaces the old hardcoded "Pipeline Builder Support"; each alias is shown
 * individually (e.g. "support" and "help") rather than a combined string.
 */
export function aliasLocalPart(alias: string): string {
  const at = alias.indexOf('@');
  return (at > 0 ? alias.slice(0, at) : alias).trim();
}
