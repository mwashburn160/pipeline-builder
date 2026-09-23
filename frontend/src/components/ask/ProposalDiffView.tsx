// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle } from 'lucide-react';
import type { ProposalDiff } from './proposal-diff';
import { rowLines } from './proposal-diff';

/** A single long / multi-line field, as a unified line diff. */
function BlockRow({ field, label, lines }: { field: string; label: string; lines: ReturnType<typeof rowLines> }) {
  return (
    <div className="space-y-1" data-testid={`ask-diff-${field}`}>
      <p className="text-xs font-medium text-fg">{label}</p>
      <pre className="max-h-56 overflow-auto rounded-md border border-default bg-surface-muted p-2 text-2xs leading-5">
        {lines.map((l, i) => (
          <div
            key={i}
            className={l.op === 'add' ? 'bg-success-bg text-success-strong' : l.op === 'del' ? 'bg-danger-bg text-danger-strong' : 'text-fg-muted'}
          >
            {l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : '  '}{l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/**
 * CURRENT -> PROPOSED, one row per field that actually changed.
 *
 * This is the review surface for every edit proposal, and it is deliberately
 * the whole story: a field that is not a row here is a field the commit will
 * not send (see `commitPayload`). Unchanged fields are absent rather than
 * greyed out, so nothing reads as an edit that isn't one, and a value the API
 * will not disclose (a webhook secret, a delivery address) shows as set /
 * not set with a note saying it cannot be applied from here.
 */
export function ProposalDiffView({ diff }: { diff: ProposalDiff }) {
  const inline = diff.rows.filter((r) => !r.block);
  const blocks = diff.rows.filter((r) => r.block);

  return (
    <div className="space-y-3" data-testid="ask-diff">
      {diff.rows.length === 0 ? (
        <p className="text-xs text-fg-muted">Nothing would change — the current values already match this proposal.</p>
      ) : (
        <>
          {inline.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-fg-subtle">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Field</th>
                    <th className="py-1 pr-2 font-medium">Current</th>
                    <th className="py-1 font-medium">Proposed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-default">
                  {inline.map((r) => (
                    <tr key={r.field} data-testid={`ask-diff-${r.field}`}>
                      <td className="py-1.5 pr-2 align-top font-medium">{r.label ?? r.field}</td>
                      <td className="max-w-[12rem] break-words py-1.5 pr-2 align-top text-fg-muted">{r.from}</td>
                      <td className="max-w-[12rem] break-words py-1.5 align-top text-fg">
                        {r.to}
                        {r.redaction && (
                          <span className="block text-2xs text-warning-strong">
                            {r.redaction === 'secret' ? 'Secret — never shown here' : 'Delivery address — never shown here'}; change it in Settings.
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {blocks.map((r) => <BlockRow key={r.field} field={r.field} label={r.label ?? r.field} lines={rowLines(r)} />)}
        </>
      )}

      {diff.refused.length > 0 && (
        <p className="flex items-start gap-1 text-2xs text-warning-strong" data-testid="ask-diff-refused">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {diff.refused.length} field{diff.refused.length === 1 ? '' : 's'} outside the reviewed change
            {diff.refused.length === 1 ? ' is' : ' are'} left out and will not be sent: {diff.refused.join(', ')}.
          </span>
        </p>
      )}
    </div>
  );
}
