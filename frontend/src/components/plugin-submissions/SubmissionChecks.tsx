// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import type { HeuristicFinding, SubmissionGate, SubmissionLintIssue } from '@/types/plugin-submissions';

const SEVERITY_COLOR = { high: 'red', medium: 'yellow', low: 'gray' } as const;

/** The automated gates, pass or fail, with their short messages. */
export function SubmissionGateList({ gates, testId = 'submission-gates' }: { gates: SubmissionGate[]; testId?: string }) {
  if (gates.length === 0) return <p className="text-xs text-fg-muted">No checks have run yet.</p>;
  return (
    <ul className="space-y-1" data-testid={testId}>
      {gates.map((g) => (
        <li key={g.id} className="flex items-start gap-2 text-sm" data-testid={`gate-${g.id}`} data-ok={g.ok}>
          {g.ok
            ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Passed" />
            : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Failed" />}
          <span>
            <span className="font-mono text-xs text-fg-muted">{g.id}</span>{' '}
            <span className={g.ok ? 'text-fg' : 'text-danger-strong'}>{g.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Heuristics findings: what matched, where, and an excerpt (rendered as text, never markup). */
export function HeuristicFindingsList({ findings }: { findings: HeuristicFinding[] }) {
  if (findings.length === 0) return <p className="text-xs text-fg-muted">Nothing suspicious found.</p>;
  return (
    <ul className="space-y-2" data-testid="heuristic-findings">
      {findings.map((f, i) => (
        <li key={`${f.id}-${f.path}-${f.line ?? i}`} className="space-y-1 text-xs" data-testid={`finding-${f.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={SEVERITY_COLOR[f.severity]}>{f.severity}</Badge>
            <span className="font-mono text-fg">{f.id}</span>
            <span className="font-mono text-fg-muted">{f.path}{f.line != null ? `:${f.line}` : ''}</span>
          </div>
          {f.excerpt && (
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-default bg-surface-muted p-2 font-mono text-fg-muted">
              {f.excerpt}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The submit page's preview of the checks that can be judged from the package
 * alone: Dockerfile / spec lint and the heuristics scan. The build, the
 * vulnerability scan and the smoke test only run after the email is confirmed.
 */
export function SubmissionChecksPreview({ lint, heuristics }: { lint: SubmissionLintIssue[]; heuristics: HeuristicFinding[] }) {
  const lintErrors = lint.filter((l) => l.severity === 'error');
  const high = heuristics.filter((h) => h.severity === 'high');
  return (
    <section aria-labelledby="checks-preview-heading" className="space-y-3" data-testid="checks-preview">
      <div>
        <h3 id="checks-preview-heading" className="text-sm font-semibold text-fg">Checks preview</h3>
        <p className="text-xs text-fg-muted">
          What can be judged from the package alone. The build, vulnerability scan and smoke test run after you confirm your email.
        </p>
      </div>

      {(lintErrors.length > 0 || high.length > 0) && (
        <Callout variant="danger" icon={AlertTriangle} title="This package would fail the automated checks">
          Fix the {lintErrors.length > 0 ? 'lint errors' : ''}{lintErrors.length > 0 && high.length > 0 ? ' and ' : ''}
          {high.length > 0 ? 'high-severity findings' : ''} below before submitting, or the submission will be refused.
        </Callout>
      )}

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Lint</h4>
        {lint.length === 0 ? (
          <p className="text-xs text-fg-muted">No lint issues.</p>
        ) : (
          <ul className="space-y-1" data-testid="lint-issues">
            {lint.map((l, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <Badge color={l.severity === 'error' ? 'red' : 'yellow'}>{l.severity}</Badge>
                <span>
                  {(l.path || l.line != null) && (
                    <span className="font-mono text-fg-muted">{l.path ?? ''}{l.line != null ? `:${l.line}` : ''} </span>
                  )}
                  {l.rule && <span className="font-mono text-fg-muted">[{l.rule}] </span>}
                  {l.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Suspicious patterns</h4>
        <HeuristicFindingsList findings={heuristics} />
      </div>
    </section>
  );
}
