// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Card } from '@/components/ui/Card';
import { fmtDate, ReportEmpty, SectionHeading, ExportCSVButton } from './ReportHelpers';
import { failureCategoryLabel } from './report-copy';
import type { ErrorCategoryRow } from './types';

interface ErrorPatternsProps {
  categories: ErrorCategoryRow[];
}

/**
 * Pipelines → Failures: the org's OWN error patterns, grouped by what kind of
 * thing broke (the ingest-time failure category), with the most frequent error
 * texts inside each. Every `reports:read` holder sees it — unlike the cross-org
 * "Top errors (all organizations)" card, which is the platform operator's read.
 */
export function ErrorPatterns({ categories }: ErrorPatternsProps) {
  const total = categories.reduce((s, c) => s + c.occurrences, 0);
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <SectionHeading>Error patterns</SectionHeading>
        <ExportCSVButton
          data={categories.flatMap((c) => (c.patterns.length > 0 ? c.patterns : [{ error_pattern: '', occurrences: 0 }]).map((p) => ({
            category: failureCategoryLabel(c.category), category_occurrences: c.occurrences, pipelines: c.affected_pipelines,
            last_seen: c.last_seen, pattern: p.error_pattern, pattern_occurrences: p.occurrences,
          })))}
          filename="error-patterns"
        />
      </div>
      {categories.length === 0 ? <ReportEmpty text="No failures with an error message in this window" /> : (
        <ul className="space-y-3">
          {categories.map((c) => {
            const share = total > 0 ? Math.round((c.occurrences / total) * 100) : 0;
            return (
              <li key={c.category}>
                <div className="flex justify-between text-sm mb-1 gap-2">
                  <span className="text-fg font-medium truncate">{failureCategoryLabel(c.category)}</span>
                  <span className="text-xs text-fg-subtle tabular-nums shrink-0">
                    {c.occurrences}x &middot; {c.affected_pipelines} pipeline{c.affected_pipelines !== 1 ? 's' : ''} &middot; {fmtDate(c.last_seen)}
                  </span>
                </div>
                <div className="h-1 bg-surface-muted rounded-full overflow-hidden mb-1.5" aria-hidden="true">
                  <div className="h-full bg-red-500 rounded-full" style={{ width: `${share}%` }} />
                </div>
                {c.patterns.length > 0 && (
                  <ul className="space-y-0.5 border-l-2 border-default pl-3">
                    {c.patterns.map((p) => (
                      <li key={p.error_pattern} className="text-xs text-fg-muted flex justify-between gap-2">
                        <span className="line-clamp-1 font-mono">{p.error_pattern}</span>
                        <span className="tabular-nums shrink-0">{p.occurrences}x</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
