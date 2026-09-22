// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { catalogDisplayValue } from '@/components/plugin/CatalogFieldEditor';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { CATALOG_FIELD_LABELS, CATALOG_SOURCE_LABELS } from '@/lib/plugin-catalog';
import { diffLines } from '@/lib/line-diff';
import type { AddedRemoved, ReviewDiff } from '@/types/ecosystem';

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h4 className="text-sm font-semibold text-fg">{title}</h4>
      {children}
    </section>
  );
}

function Delta({ label, delta, danger = false }: { label: string; delta: AddedRemoved; danger?: boolean }) {
  if (delta.added.length === 0 && delta.removed.length === 0) return null;
  return (
    <div className="text-xs" data-testid={`contract-${label}`}>
      <span className="font-medium text-fg">{label}</span>
      <ul className="mt-0.5 space-y-0.5 font-mono">
        {delta.added.map((v) => (
          <li key={`+${v}`} className={danger ? 'text-danger-strong' : 'text-success-strong'}>+ {v}</li>
        ))}
        {delta.removed.map((v) => <li key={`-${v}`} className="text-fg-muted">- {v}</li>)}
      </ul>
    </div>
  );
}

function CommandsDiff({ label, d }: { label: string; d: { previous: string[]; current: string[]; changed: boolean } }) {
  if (!d.changed) return null;
  return (
    <div className="text-xs">
      <span className="font-medium text-fg">{label} changed</span>
      <LineDiff previous={d.previous.join('\n')} current={d.current.join('\n')} />
    </div>
  );
}

function LineDiff({ previous, current }: { previous: string | null; current: string | null }) {
  const lines = diffLines(previous, current);
  return (
    <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-default bg-surface-muted p-2 text-xs leading-5" data-testid="line-diff">
      {lines.map((l, i) => (
        <div
          key={i}
          className={l.op === 'add' ? 'bg-success-bg text-success-strong' : l.op === 'del' ? 'bg-danger-bg text-danger-strong' : 'text-fg-muted'}
        >
          {l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : '  '}{l.text}
        </div>
      ))}
    </pre>
  );
}

const count = (n: number | null | undefined) => (n == null ? '—' : String(n));

/**
 * The publish-request review view: everything that changed against the previous APPROVED
 * version — catalog metadata with provenance (user-edited links highlighted as
 * the phishing check), the execution contract, vulnerabilities, Dockerfile,
 * SBOM, icon, gate results, publisher history and auto-approval eligibility.
 */
export function ReviewDiffView({ review }: { review: ReviewDiff }) {
  const c = review.contract;
  const highlighted = review.metadata.filter((m) => m.highlight);
  const contractEmpty = !!c
    && [c.secrets, c.egress, c.requiredMetadata, c.requiredVars].every((d) => d.added.length === 0 && d.removed.length === 0)
    && c.env.added.length === 0 && c.env.removed.length === 0 && c.env.changed.length === 0
    && !c.commands.changed && !c.installCommands.changed && !c.runAsRoot.regression
    && c.pluginType.previous === c.pluginType.current && c.computeType.previous === c.computeType.current;

  return (
    <div className="space-y-5" data-testid="review-diff">
      <p className="text-xs text-fg-muted">
        {review.previousVersion
          ? <>Compared with the previous approved version <span className="font-mono">{review.previousVersion}</span>.</>
          : 'No previous approved version — everything below is new.'}
      </p>

      {highlighted.length > 0 && (
        <Callout variant="warning" icon={AlertTriangle} title="Edited links — check where they go">
          The publisher typed {highlighted.length === 1 ? 'this link' : 'these links'} instead of taking the package&apos;s value:{' '}
          {highlighted.map((m) => CATALOG_FIELD_LABELS[m.field]).join(', ')}. A changed link is how a phishing edit looks.
        </Callout>
      )}

      <Section title="Checks" testId="review-gates">
        <ul className="space-y-1">
          {review.gates.map((g) => (
            <li key={g.id} className="flex items-start gap-2 text-sm">
              {g.ok
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Passed" />
                : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Failed" />}
              <span>{g.message}</span>
            </li>
          ))}
          {review.gates.length === 0 && <li className="text-xs text-fg-muted">No gates apply to this request.</li>}
        </ul>
      </Section>

      <Section title="Auto-approval">
        <p className="text-sm">
          {review.autoApproval.eligible
            ? <Badge color="green">Eligible{review.autoApproval.ruleName ? ` under "${review.autoApproval.ruleName}"` : ''}</Badge>
            : <Badge color="gray">Not eligible</Badge>}
          {review.autoApproval.bump && <span className="ml-2 text-xs text-fg-muted">{review.autoApproval.bump} bump</span>}
          {review.autoApproval.bootstrapOpen && <Badge color="blue" className="ml-2">Bootstrap exception open</Badge>}
        </p>
        {review.autoApproval.reasons.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-fg-muted">
            {review.autoApproval.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
      </Section>

      {review.metadata.length > 0 && (
        <Section title="Listing details" testId="review-metadata">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-fg-subtle">
                <tr>
                  <th className="py-1 pr-2 font-medium">Field</th>
                  <th className="py-1 pr-2 font-medium">Previous</th>
                  <th className="py-1 pr-2 font-medium">Proposed</th>
                  <th className="py-1 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {review.metadata.map((m) => (
                  <tr
                    key={m.field}
                    data-testid={`review-field-${m.field}`}
                    data-highlight={m.highlight || undefined}
                    className={m.highlight ? 'bg-warning-bg' : m.changed ? '' : 'text-fg-muted'}
                  >
                    <td className="py-1.5 pr-2 font-medium align-top">
                      {CATALOG_FIELD_LABELS[m.field] ?? m.field}
                      {m.changed && <span className="ml-1 text-info-strong">changed</span>}
                    </td>
                    <td className="py-1.5 pr-2 align-top break-words max-w-[14rem]">{catalogDisplayValue(m.field, m.previous) || '—'}</td>
                    <td className="py-1.5 pr-2 align-top break-words max-w-[14rem]">
                      {catalogDisplayValue(m.field, m.value) || '—'}
                      {m.highlight && <span className="block font-medium text-warning-strong">Edited link</span>}
                    </td>
                    <td className="py-1.5 align-top">
                      {m.source && <Badge color={m.userEdited ? 'purple' : 'gray'}>{CATALOG_SOURCE_LABELS[m.source]}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {c && (
        <Section title="Execution contract" testId="review-contract">
          {contractEmpty ? (
            <p className="text-xs text-fg-muted">No change to secrets, egress, required inputs, env keys, commands or root.</p>
          ) : (
            <div className="space-y-2">
              <Delta label="Secrets" delta={c.secrets} danger />
              <Delta label="Network egress" delta={c.egress} danger />
              <Delta label="Required metadata" delta={c.requiredMetadata} danger />
              <Delta label="Required variables" delta={c.requiredVars} danger />
              <Delta label="Env keys" delta={c.env} />
              {c.env.changed.length > 0 && (
                <p className="text-xs"><span className="font-medium">Env values changed:</span> <span className="font-mono">{c.env.changed.join(', ')}</span></p>
              )}
              <CommandsDiff label="Commands" d={c.commands} />
              <CommandsDiff label="Install commands" d={c.installCommands} />
              {c.runAsRoot.regression && (
                <Callout variant="danger" title="Now runs as root">The previous version ran as a non-root user.</Callout>
              )}
              {c.pluginType.previous !== c.pluginType.current && (
                <p className="text-xs">Plugin type: {c.pluginType.previous ?? '—'} to {c.pluginType.current ?? '—'}</p>
              )}
              {c.computeType.previous !== c.computeType.current && (
                <p className="text-xs">Compute type: {c.computeType.previous ?? '—'} to {c.computeType.current ?? '—'}</p>
              )}
            </div>
          )}
        </Section>
      )}

      {review.vuln && (
        <Section title="Vulnerabilities" testId="review-vuln">
          <p className="text-xs">
            Critical {count(review.vuln.previous?.critical)} to {count(review.vuln.current.critical)}, high{' '}
            {count(review.vuln.previous?.high)} to {count(review.vuln.current.high)}.
            {' '}{review.vuln.current.scannedAt ? `Scanned ${new Date(review.vuln.current.scannedAt).toLocaleString()}.` : 'Not scanned.'}
          </p>
          {(review.vuln.newCritical > 0 || review.vuln.newHigh > 0) && (
            <p className="text-xs font-medium text-danger-strong">
              New: {review.vuln.newCritical} critical, {review.vuln.newHigh} high.
            </p>
          )}
        </Section>
      )}

      {review.icon?.changed && (
        <Section title="Icon">
          <p className="text-xs">
            {catalogDisplayValue('icon', review.icon.previous) || 'none'} to {catalogDisplayValue('icon', review.icon.current) || 'none'}
          </p>
          {review.icon.curatedMark && (
            <p className="text-xs font-medium text-warning-strong">Resembles a curated vendor mark — confirm the publisher may use it.</p>
          )}
        </Section>
      )}

      {review.dockerfile && (
        <Section title="Dockerfile" testId="review-dockerfile">
          {review.dockerfile.changed || !review.dockerfile.previous
            ? <LineDiff previous={review.dockerfile.previous} current={review.dockerfile.current} />
            : <p className="text-xs text-fg-muted">Unchanged.</p>}
        </Section>
      )}

      {review.sbom && (
        <Section title="SBOM packages" testId="review-sbom">
          {review.sbom.error ? (
            <p className="text-xs text-warning-strong">Could not compare SBOMs: {review.sbom.error}</p>
          ) : review.sbom.added.length === 0 && review.sbom.removed.length === 0 ? (
            <p className="text-xs text-fg-muted">No package changes.</p>
          ) : (
            <Delta label="Packages" delta={{ added: review.sbom.added, removed: review.sbom.removed }} />
          )}
        </Section>
      )}

      <Section title="Publisher history">
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <TrustTierBadge tier={review.publisherHistory.tier} />
          <span>Since {new Date(review.publisherHistory.createdAt).toLocaleDateString()}</span>
          <span>{review.publisherHistory.listings} listings</span>
          <span>{review.publisherHistory.approved} approved</span>
          <span>{review.publisherHistory.rejected} rejected</span>
        </div>
      </Section>
    </div>
  );
}
