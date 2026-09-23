// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ComplianceNote, Proposal, TemplateValidationNote } from './proposal';

/**
 * What the tools found out about a draft before handing it over: the org's own
 * policy verdict, and (for templates) whether the create route would refuse it.
 *
 * Both are rendered ABOVE the fold rather than inside the review disclosure. A
 * draft that violates a rule the org wrote, or that the create route would
 * 400, is the first thing worth knowing — burying it behind a summary is how a
 * confident-sounding answer ends in a 403 nobody predicted.
 */
function Compliance({ note }: { note: ComplianceNote }) {
  if (note.checked === false) {
    return (
      <p className="mt-1 flex items-start gap-1 text-2xs text-warning-strong" data-testid="ask-compliance-unchecked">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>Not checked against the organization&apos;s compliance rules{note.unavailable ? `: ${note.unavailable}` : '.'}</span>
      </p>
    );
  }
  const findings = [...(note.violations ?? []), ...(note.warnings ?? [])];
  if (findings.length === 0) {
    return (
      <p className="mt-1 flex items-center gap-1 text-2xs text-success" data-testid="ask-compliance-ok">
        <ShieldCheck className="h-3 w-3 shrink-0" /> Passes the organization&apos;s compliance rules.
      </p>
    );
  }
  return (
    <div className={`mt-1 text-2xs ${note.blocked ? 'text-danger' : 'text-warning-strong'}`} data-testid="ask-compliance-findings">
      <p className="flex items-center gap-1">
        <ShieldAlert className="h-3 w-3 shrink-0" />
        {note.blocked ? 'Compliance would BLOCK this — creating it will be refused.' : 'Compliance warnings.'}
      </p>
      <ul className="mt-0.5 list-disc pl-5">
        {findings.slice(0, 6).map((f, i) => (
          <li key={`${f.ruleId ?? f.ruleName ?? i}`}>{f.ruleName ? `${f.ruleName}: ` : ''}{f.message}</li>
        ))}
      </ul>
    </div>
  );
}

function Validation({ note }: { note: TemplateValidationNote }) {
  if (note.valid !== false) return null;
  return (
    <div className="mt-1 text-2xs text-danger" data-testid="ask-validation">
      <p className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 shrink-0" /> The template as drafted would be refused:</p>
      <ul className="mt-0.5 list-disc pl-5">
        {(note.errors ?? []).slice(0, 6).map((e, i) => <li key={`e${i}`}>{e.field ? `${e.field}: ` : ''}{e.message}</li>)}
        {(note.cycles ?? []).map((c, i) => <li key={`c${i}`}>Reference cycle: {c.join(' -> ')}</li>)}
        {(note.undeclaredVars ?? []).length > 0 && <li>Undeclared variables: {(note.undeclaredVars ?? []).join(', ')}</li>}
      </ul>
    </div>
  );
}

/** The policy / validation verdicts a proposal arrived with, if any. */
export function ProposalNotes({ p }: { p: Proposal }) {
  return (
    <>
      {p.compliance && <Compliance note={p.compliance} />}
      {p.validation && <Validation note={p.validation} />}
    </>
  );
}
