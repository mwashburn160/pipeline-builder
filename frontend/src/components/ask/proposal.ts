// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser half of the Ask agent's propose/confirm contract: the shape a
 * proposal arrives in, and how the card presents each kind. Nothing here
 * writes — a proposal is data until the user commits it (`proposal-commit.ts`),
 * through their own session and their own permissions.
 *
 * The wire shape is `api/ask/src/services/proposals.ts` (`AskProposal`). It is
 * mirrored here as an all-optional structural type on purpose: what arrives is
 * JSON off an SSE stream, so every field is read defensively and an unknown
 * `kind` renders nothing rather than crashing the transcript.
 *
 * Three families of kind:
 *  - CREATE (`pipeline`, `plugin`, `template`) — a drafted document, reviewed
 *    as a spec.
 *  - CHANGE (`*-edit`, `org-settings-edit`) — a drafted CHANGE, reviewed as a
 *    CURRENT -> PROPOSED diff. These carry both sides plus `changedFields`, and
 *    the diff the user sees is literally the payload that gets sent.
 *    `org-settings-edit` is the one whose fields are enumerated centrally:
 *    both sides are keyed by the shared allowlist's `<surface>.<field>` keys
 *    (`@pipeline-builder/api-core/ask-proposals`), which also supplies the
 *    label, the value shape, the permission and the route — so this file never
 *    re-states any of them, and `changedFields` is not consulted for that kind.
 *  - REMEDIATION (`install-change-request`, `compliance-exemption-request`) —
 *    the platform already has an approval queue for these, so committing FILES
 *    A REQUEST into it. The user requests; an approver who was never in the
 *    conversation decides.
 */

import {
  ASK_AGENT_PROPOSER, diffOrgSettings, pickAllowed,
  type OrgSettingChange, type OrgSettingKey, type OrgSettingPatch,
} from '@pipeline-builder/api-core/ask-proposals';
import { GitBranch, LayoutTemplate, Package, PackageCheck, Settings, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DiffRow, ProposalDiff } from './proposal-diff';
import { computeProposalDiff, describeValue, redactionFor } from './proposal-diff';

export type ProposalKind =
  | 'pipeline'
  | 'plugin'
  | 'template'
  | 'pipeline-edit'
  | 'plugin-edit'
  | 'template-edit'
  | 'org-settings-edit'
  | 'install-change-request'
  | 'compliance-exemption-request';

/** Where a change proposal commits, as the tool declares it (mirrors `CommitTarget`). */
export interface CommitTarget {
  service?: string;
  method?: string;
  /** Route template; this is what selects the typed client the browser calls. */
  path?: string;
  permission?: string;
}

/** The org's policy verdict on a draft (mirrors `ComplianceNote`). */
export interface ComplianceNote {
  checked?: boolean;
  compliant?: boolean;
  blocked?: boolean;
  violations?: Array<{ ruleId?: string; ruleName?: string; message?: string; severity?: string }>;
  warnings?: Array<{ ruleId?: string; ruleName?: string; message?: string; severity?: string }>;
  unavailable?: string;
}

/** Why a drafted template would be refused by the create route (`TemplateValidationNote`). */
export interface TemplateValidationNote {
  valid?: boolean;
  errors?: Array<{ field?: string; message?: string }>;
  cycles?: string[][];
  undeclaredVars?: string[];
}

/** A reviewable draft the agent produced (nothing is written until the user commits). */
export interface Proposal {
  kind: ProposalKind;
  description?: string;
  /**
   * `{ proposedBy: ASK_AGENT_PROPOSER }` — the wire marker every tool stamps.
   * Carried for completeness; the panel does not gate on it, because a card in
   * this panel is agent-drafted by construction and a marker the stream itself
   * supplies could not prove otherwise.
   */
  provenance?: { proposedBy?: string };
  /** Fields the TOOL refused (outside its allowlist): the injection signal. */
  refusedFields?: string[];
  /** The tool declined (quota, not found, validation); nothing else is meaningful. */
  error?: string;

  // -- CREATE ---------------------------------------------------------------
  props?: Record<string, unknown>;
  config?: Record<string, unknown>;
  dockerfile?: string;
  template?: Record<string, unknown>;
  validation?: TemplateValidationNote;
  compliance?: ComplianceNote;

  // -- CHANGE / remediation -------------------------------------------------
  /** The entity's id (goes into the commit route's `:id`). */
  id?: string;
  /** Human label for the card ("node-ci", "acme/scanner"). */
  target?: string;
  /** The state the diff was rendered against — re-read before the commit lands. */
  current?: Record<string, unknown>;
  /** The drafted state. Only fields named in `changedFields` can be applied. */
  proposed?: Record<string, unknown>;
  /** The fields the tool declares it changed. An allowlist, not a hint. */
  changedFields?: string[];
  /** Leaf paths inside object-valued fields, for a finer-grained read of a big blob. */
  changedPaths?: string[];
  /** Single commit target (`*-edit`, `install-change-request`, exemption). */
  commit?: CommitTarget;
  /** Free-text note filed with an install change request. */
  note?: string;
  /** What the proposed upgrade clears. */
  clears?: Array<{ id?: string; severity?: string; summary?: string; fixedVersion?: string | null }>;
  /** `compliance-exemption-request`: exactly the create body. */
  request?: Record<string, unknown>;

  // -- org-settings-edit ----------------------------------------------------
  // The wire also carries `labels` (a per-key display name) and `requests` (the
  // planned per-surface bodies). Neither is read here, deliberately: the label
  // and the body both come from the SHARED allowlist this file already imports,
  // and a commit body that arrived over the stream would be a payload the user
  // reviewed only by proxy. Re-deriving them is what makes rule 3 hold on this
  // side of the wire rather than being asserted on the other.
  /** Allowlisted keys the tool drafted with a value outside the declared domain. */
  invalidFields?: string[];
  /** Allowlisted keys dropped because their CURRENT value could not be read. */
  unreadableFields?: string[];
}

/** Per-kind card presentation + the dashboard the change lands on. */
export interface ProposalMeta {
  label: string;
  icon: LucideIcon;
  createLabel: string;
  /** The button's in-flight label. */
  busyLabel: string;
  /** What the line beside a ready button says. */
  reviewHint: string;
  href: string;
  createdText: string;
  /**
   * The permission the panel requires BEFORE looking at anything on the wire.
   * `org-settings-edit` has none of its own: its fields span three services, so
   * the requirement is the union of the surfaces the reviewed fields touch.
   */
  permission?: string;
  /**
   * The commit files a REQUEST into an existing approval queue instead of
   * writing. The card says so, because "Apply" would be a lie: an approver who
   * was not in this conversation decides.
   */
  filesRequest?: boolean;
}

const CREATE_VERBS = { busyLabel: 'Creating…', reviewHint: 'Review before creating' } as const;
const APPLY_VERBS = { busyLabel: 'Applying…', reviewHint: 'Review before applying' } as const;
const REQUEST_VERBS = { busyLabel: 'Requesting…', reviewHint: 'Review before requesting' } as const;

export const PROPOSAL_META: Record<ProposalKind, ProposalMeta> = {
  pipeline: { label: 'Proposed pipeline', icon: GitBranch, createLabel: 'Create pipeline', ...CREATE_VERBS, href: '/dashboard/pipelines', createdText: 'Created — open pipelines', permission: 'pipelines:write' },
  plugin: { label: 'Proposed plugin', icon: Package, createLabel: 'Create plugin', ...CREATE_VERBS, href: '/dashboard/plugins', createdText: 'Build queued — open plugins', permission: 'plugins:write' },
  template: { label: 'Proposed template', icon: LayoutTemplate, createLabel: 'Create template', ...CREATE_VERBS, href: '/dashboard/templates', createdText: 'Created — open templates', permission: 'templates:write' },

  'pipeline-edit': { label: 'Proposed pipeline change', icon: GitBranch, createLabel: 'Apply change', ...APPLY_VERBS, href: '/dashboard/pipelines', createdText: 'Applied — open pipelines', permission: 'pipelines:write' },
  'plugin-edit': { label: 'Proposed plugin change', icon: Package, createLabel: 'Apply change', ...APPLY_VERBS, href: '/dashboard/plugins', createdText: 'Applied — open plugins', permission: 'plugins:write' },
  'template-edit': { label: 'Proposed template change', icon: LayoutTemplate, createLabel: 'Apply change', ...APPLY_VERBS, href: '/dashboard/templates', createdText: 'Applied — open templates', permission: 'templates:write' },
  'org-settings-edit': { label: 'Proposed organization setting', icon: Settings, createLabel: 'Apply setting', ...APPLY_VERBS, href: '/dashboard/settings', createdText: 'Applied — open settings' },

  'install-change-request': {
    label: 'Proposed install change',
    icon: PackageCheck,
    // Requests, not applies: `plugin_installs:manage` decides, in the org's queue.
    createLabel: 'Request change',
    ...REQUEST_VERBS,
    href: '/dashboard/plugins?tab=installs',
    createdText: 'Requested — open installs',
    permission: 'plugins:install',
    filesRequest: true,
  },
  'compliance-exemption-request': {
    label: 'Proposed compliance exemption',
    icon: ShieldCheck,
    // Any member may REQUEST one; an admin reviews it (self-approval is blocked
    // server-side), so this button never weakens the org's posture by itself.
    createLabel: 'Request exemption',
    ...REQUEST_VERBS,
    href: '/dashboard/compliance',
    createdText: 'Requested — open compliance',
    permission: 'compliance:read',
    filesRequest: true,
  },
};

const DIFF_KINDS = new Set<ProposalKind>([
  'pipeline-edit', 'plugin-edit', 'template-edit', 'org-settings-edit',
  'install-change-request', 'compliance-exemption-request',
]);

/** True for every kind reviewed as a CURRENT -> PROPOSED diff. */
export function isDiffProposal(p: Proposal): boolean {
  return DIFF_KINDS.has(p.kind);
}

/**
 * The sentence that carries provenance to a human approver.
 *
 * Rule 6 wants `details: { proposedBy: 'ask-agent' }` on the commit's audit
 * event. Two of these kinds file into a queue whose route already has a
 * free-text field that reaches the approver AND the audit row — the install
 * change-request `note` and the exemption `reason` — so the marker travels
 * there, built from the SHARED constant rather than a retyped literal. The
 * other kinds have no such channel; see the module note in `proposal-commit.ts`.
 *
 * It is folded into `proposed` BEFORE the diff is rendered, so the sentence the
 * approver reads is part of what the requester reviewed — a line appended after
 * review would be a field the user never saw.
 */
export const ASK_AGENT_PROVENANCE_NOTE =
  `Drafted by the Ask agent (${ASK_AGENT_PROPOSER}) and filed after review by the requester.`;

/** Which free-text field on a kind carries the provenance sentence to approvers. */
const PROVENANCE_FIELD: Partial<Record<ProposalKind, string>> = {
  'install-change-request': 'note',
  'compliance-exemption-request': 'reason',
};

/** Fold the provenance sentence into a field the route already delivers to approvers. */
function withProvenance(kind: ProposalKind, proposed: Record<string, unknown> | undefined, changed: string[] | undefined) {
  const field = PROVENANCE_FIELD[kind];
  if (!field) return { proposed, changed };
  const existing = typeof proposed?.[field] === 'string' ? String(proposed[field]).trim() : '';
  return {
    proposed: { ...proposed, [field]: existing ? `${existing}\n\n${ASK_AGENT_PROVENANCE_NOTE}` : ASK_AGENT_PROVENANCE_NOTE },
    changed: changed?.includes(field) ? changed : [...(changed ?? []), field],
  };
}

/**
 * The two diff sides for a proposal, normalized.
 *
 * `compliance-exemption-request` is the one kind with no `current`: it creates
 * a new queue row rather than editing one, so its `request` body IS the
 * proposal and every field of it is a change from nothing. Normalizing it into
 * the same two-sided shape means one renderer, one payload builder and one
 * staleness rule for every reviewable kind.
 */
export function proposalSides(p: Proposal): { current: Record<string, unknown>; proposed: Record<string, unknown>; changed: string[] } {
  if (p.kind === 'compliance-exemption-request') {
    const req = p.request ?? {};
    const { proposed, changed } = withProvenance(p.kind, req, Object.keys(req));
    return { current: {}, proposed: proposed ?? {}, changed: changed ?? [] };
  }
  // The install change-request's note travels beside the diff on the wire; it is
  // part of what gets filed, so it is folded in and reviewed like any other field.
  const base = p.kind === 'install-change-request' && typeof p.note === 'string'
    ? { ...p.proposed, note: p.note }
    : p.proposed;
  const { proposed, changed } = withProvenance(p.kind, base, p.changedFields);
  return { current: p.current ?? {}, proposed: proposed ?? {}, changed: changed ?? [] };
}

// -----------------------------------------------------------------------------
// Org settings — the shared allowlist decides, this file only renders it
// -----------------------------------------------------------------------------

/** What an org-settings proposal amounts to once the shared allowlist has spoken. */
export interface OrgSettingsReview {
  /** The changes, no-ops already dropped by `diffOrgSettings`. */
  changes: readonly OrgSettingChange[];
  /** Allowlisted, shape-valid values — re-diffed against a fresh read before committing. */
  proposed: OrgSettingPatch;
  /** The draft's baseline, filtered the same way. */
  current: OrgSettingPatch;
  /** Keys the proposal named that are NOT proposable at all (rule 10: the injection signal). */
  refused: readonly string[];
  /** Allowlisted keys whose value did not match the declared shape. */
  invalid: readonly OrgSettingKey[];
}

/**
 * Run an org-settings proposal through the SHARED allowlist.
 *
 * `pickAllowed` is applied on this side too, not just in the tool: the browser
 * is what actually issues the write, so it enforces the same table rather than
 * trusting that the stream already did. `diffOrgSettings` then drops every
 * no-op, so a setting that already holds the proposed value cannot read as an
 * edit.
 */
export function orgSettingsReview(p: Proposal): OrgSettingsReview {
  const { allowed, refused, invalid } = pickAllowed(p.proposed);
  const current = pickAllowed(p.current).allowed;
  return { changes: diffOrgSettings(current, allowed), proposed: allowed, current, refused, invalid };
}

/** The allowlist's changes, as rows the shared diff view renders. */
export function orgSettingsRows(changes: readonly OrgSettingChange[]): DiffRow[] {
  return changes.map((c) => {
    // Defence in depth: the allowlist admits no secret, so this can only fire if
    // one is ever added by mistake — and then it is shown as presence and
    // dropped from the payload rather than typed into a card.
    const redaction = redactionFor(c.spec.field);
    return {
      field: c.spec.key,
      label: c.spec.label,
      from: describeValue(c.from, redaction),
      to: describeValue(c.to, redaction),
      redaction,
      block: false,
    };
  });
}

/**
 * The changes that may actually be sent: everything the shared allowlist
 * produced, minus anything whose value is rendered as presence only.
 *
 * The allowlist admits no secret today, so this is defence in depth — but it is
 * the same rule the entity diff enforces, applied at the one place the
 * org-settings bodies are built, so a credential added to the table by mistake
 * could be reviewed as "set / not set" and still never leave the browser.
 */
export function appliableOrgSettingChanges(changes: readonly OrgSettingChange[]): readonly OrgSettingChange[] {
  return changes.filter((c) => !redactionFor(c.spec.field));
}

/**
 * The reviewable diff — the single source used by BOTH the card and the commit,
 * so what is rendered and what is sent cannot drift.
 */
export function proposalDiff(p: Proposal): ProposalDiff {
  if (p.kind === 'org-settings-edit') {
    const review = orgSettingsReview(p);
    return { rows: orgSettingsRows(review.changes), unchanged: [], refused: [...review.refused, ...review.invalid] };
  }
  const sides = proposalSides(p);
  return computeProposalDiff(sides.current, sides.proposed, sides.changed);
}

/**
 * Every permission the viewer must hold to commit this proposal.
 *
 * The per-kind entry is the floor. A `commit.permission` that arrives on the
 * wire is ADDED to it, never substituted: a tampered stream can then only make
 * the gate stricter, never weaker. `org-settings-edit` has no floor of its own
 * — its fields span three services — so its requirement is the union of
 * `spec.permission` over the changes the shared allowlist produced. The
 * permission comes from the table, never from the stream.
 */
export function requiredPermissions(p: Proposal): string[] {
  const out = new Set<string>();
  const base = PROPOSAL_META[p.kind]?.permission;
  if (base) out.add(base);

  if (p.kind === 'org-settings-edit') {
    for (const c of orgSettingsReview(p).changes) out.add(c.spec.permission);
    // Nothing appliable: keep the action inert behind the strictest gate we know
    // rather than enabled with no requirement at all.
    if (out.size === 0) out.add('org:settings');
    return [...out];
  }

  if (p.commit?.permission) out.add(p.commit.permission);
  return [...out];
}

/**
 * Whether a draft carries what its commit API requires (gates the button).
 * For a diff proposal that includes having something appliable left after the
 * refusals: a proposal whose every field was refused must not offer an Apply.
 */
export function proposalReady(p: Proposal): boolean {
  if (p.error) return false;
  switch (p.kind) {
    case 'pipeline':
      return !!(p.props?.project && p.props?.organization);
    case 'plugin':
      return !!(p.config && p.dockerfile);
    case 'template':
      return !!(p.template as { name?: string } | undefined)?.name;
    default: {
      const rows = proposalDiff(p).rows;
      if (!rows.some((r) => !r.redaction)) return false;
      if (p.kind === 'compliance-exemption-request') {
        const q = p.request ?? {};
        return !!(q.ruleId && q.entityType && q.entityId && q.reason);
      }
      // org-settings needs no extra check: a row exists only for a change the
      // shared allowlist produced, and every spec names a surface this app serves.
      return !!p.id;
    }
  }
}
