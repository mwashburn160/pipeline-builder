// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * THE PROPOSAL CONTRACT.
 *
 * Every `propose_*` agent tool returns one of these objects, and the route
 * forwards it verbatim as an SSE `{ type: 'proposal', data }` event. It is the
 * whole interface between this service and the Ask panel's review card: the UI
 * renders the shape and, on Apply, commits it THROUGH THE USER'S OWN SESSION.
 * Nothing here is written by the agent.
 *
 * Two families:
 *
 *  - CREATE proposals (`pipeline` | `plugin` | `template`) carry a whole new
 *    document. Unchanged from the shipped contract.
 *  - CHANGE proposals (everything else) carry BOTH sides — `current` and
 *    `proposed`, keyed by the same field names, plus `changedFields`. The commit
 *    payload is exactly `pick(proposed, changedFields)`: a field the model
 *    slipped in that the card never rendered is structurally unappliable,
 *    because it is not in `changedFields` and so is never picked. That is design
 *    rule 3 — the reviewed diff IS the commit payload — expressed as a type.
 *
 * `current` is also the RE-READ BASELINE (design rule 7). These tables carry no
 * version column, so before applying, the UI re-reads the entity and refuses
 * when any field in `changedFields` no longer equals `current[field]` — the
 * approved diff must be the applied diff.
 *
 * `provenance` is design rule 6: the commit records
 * `details: { proposedBy: 'ask-agent' }` so the hash-chained audit trail can
 * tell "the admin changed this" from "an AI drafted it and the admin applied it".
 */

import { ASK_AGENT_PROPOSER } from '@pipeline-builder/api-core';
import type { AskProposalProvenance, ComplianceExemptionRequest, OrgSettingRequest, OrgSettingValue } from '@pipeline-builder/api-core';
import type { TemplateDraftValidation } from '@pipeline-builder/pipeline-core';

/**
 * Stamped into every proposal; the UI passes it to the create/update call's
 * audit details. The literal itself lives in api-core's shared
 * `ask-proposals` module (design rule 6) so this service and the browser's
 * confirm handler cannot drift into two spellings of it — a typo would produce
 * an unqueryable audit trail rather than a compile error.
 */
export const ASK_PROVENANCE: AskProposalProvenance = { proposedBy: ASK_AGENT_PROPOSER };
export type AskProvenance = AskProposalProvenance;

/** Which service, verb and route commits a change proposal, and what it needs. */
export interface CommitTarget {
  service: 'pipeline' | 'plugin' | 'platform' | 'compliance';
  method: 'POST' | 'PUT' | 'PATCH';
  /** Path template with `:id` where the proposal's `id` goes. */
  path: string;
  /** The capability the USER must hold — the UI hides/disables Apply without it. */
  permission: string;
}

/** One rule the org's policy engine raised against a draft. */
export interface ComplianceFinding {
  ruleId?: string;
  ruleName?: string;
  message: string;
  severity?: string;
}

/**
 * The policy verdict attached to a draft (design rule: the agent must not draft
 * in ignorance of policy-as-code). `checked: false` means the dry-run could not
 * run — the draft is returned with the reason NAMED rather than silently
 * presented as compliant.
 */
export interface ComplianceNote {
  checked: boolean;
  /** Passed with nothing blocking. Meaningless when `checked` is false. */
  compliant: boolean;
  blocked: boolean;
  violations: ComplianceFinding[];
  warnings: ComplianceFinding[];
  /** How many of the org's rules ran, and how many could not be judged on a draft. */
  rulesEvaluated?: number;
  rulesSkipped?: number;
  /** Present only when `checked` is false: why, in shaped terms (never a downstream body). */
  unavailable?: string;
}

/** Fields shared by every proposal the agent can emit. */
interface ProposalBase {
  provenance: AskProvenance;
  /** Short human sentence for the card ("adds a test stage before deploy"). */
  description?: string;
  /**
   * Design rule 10: fields the model asked to change that are NOT in the tool's
   * allowlist. Always present (empty when clean) — a non-empty array is the
   * injection signal and is surfaced on the card, not silently dropped.
   */
  refusedFields: string[];
  /** Set when the tool declined (quota, not found, validation); no other field is meaningful. */
  error?: string;
}

// -- CREATE proposals ---------------------------------------------------------

export interface PipelineProposal extends ProposalBase {
  kind: 'pipeline';
  props?: unknown;
  keywords?: string[];
  /** Repository analysis summary, when drafted from a Git URL. */
  analysis?: unknown;
  compliance?: ComplianceNote;
}

export interface PluginProposal extends ProposalBase {
  kind: 'plugin';
  config?: unknown;
  dockerfile?: string;
  analysis?: unknown;
  compliance?: ComplianceNote;
}

export interface TemplateProposal extends ProposalBase {
  kind: 'template';
  template?: unknown;
  /**
   * Template-engine verdict from pipeline-core's `validateTemplateDraft`: parse
   * errors anywhere in the body, reserved/unknown scope roots, reference cycles,
   * undeclared `{{ vars.NAME }}`, and unusable or unused declared inputs.
   * `valid: false` means the draft should not be offered as it stands.
   */
  validation?: TemplateDraftValidation;
  compliance?: ComplianceNote;
}

// -- CHANGE proposals ---------------------------------------------------------

/**
 * An edit to an existing entity. `current` and `proposed` are keyed by the SAME
 * top-level names as `changedFields`; `changedPaths` names the leaves that
 * differ inside any object-valued field, purely so the card can render a
 * fine-grained diff of a big `props` blob.
 */
export interface EditProposal extends ProposalBase {
  kind: 'pipeline-edit' | 'plugin-edit' | 'template-edit';
  /** The entity's id — goes into `commit.path`'s `:id`. */
  id: string;
  /** Human label for the card ("node-ci"). */
  target: string;
  changedFields: string[];
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  changedPaths: string[];
  commit: CommitTarget;
  compliance?: ComplianceNote;
  /** Template edits only: the merged document's template-engine verdict. */
  validation?: TemplateDraftValidation;
}

/**
 * An org-settings change. Same diff contract, but the proposable fields, their
 * value domains and the routes that apply them all come from api-core's shared
 * `ask-proposals` allowlist — the same module the browser's confirm handler
 * reads, so there is exactly one policy.
 *
 * Every allowlisted setting is a scalar with a closed shape, so there is no
 * nested `changedPaths` to render: `changedFields` (allowlist keys) is the whole
 * diff. `requests` is the commit payload, already grouped one-per-surface and
 * translated from proposal keys back to each API's own field names.
 */
export interface OrgSettingsProposal extends ProposalBase {
  kind: 'org-settings-edit';
  /** The AUTHENTICATED caller's org — never model-supplied. */
  id: string;
  target: string;
  /** Allowlist keys (`<surface>.<field>`) that actually change. */
  changedFields: string[];
  current: Record<string, OrgSettingValue | null>;
  proposed: Record<string, OrgSettingValue>;
  /** Human label per changed key, for the review card. */
  labels: Record<string, string>;
  /** One request per surface: method, path, permission and body. THE commit payload. */
  requests: readonly OrgSettingRequest[];
  /**
   * Allowlisted keys whose VALUE was outside the declared domain. Reported
   * apart from `refusedFields`: a bad value is a drafting mistake, an unknown
   * field is the injection signal.
   */
  invalidFields: string[];
  /**
   * Allowlisted keys dropped because their CURRENT value could not be read, so
   * there is no baseline for the confirm handler to re-read against (rule 7).
   */
  unreadableFields: string[];
}

// -- REMEDIATION proposals ----------------------------------------------------

/**
 * A plugin-install change filed into the org's EXISTING approval queue
 * (`POST /plugins/installs/:id/change-requests`). Creating the request is itself
 * a write — it stores a pending change on the install, audits it and notifies
 * approvers — so the agent proposes it and the user's session files it.
 */
export interface InstallChangeProposal extends ProposalBase {
  kind: 'install-change-request';
  /** The install row id — goes into `commit.path`'s `:id`. */
  id: string;
  /** `publisher/name`. */
  target: string;
  changedFields: string[];
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  changedPaths: string[];
  commit: CommitTarget;
  /** Free-text note that travels to the approver with the request. */
  note?: string;
  /** Why this upgrade: the advisories/flags the current resolution carries. */
  clears?: Array<{ id?: string; severity?: string; summary?: string; fixedVersion?: string | null }>;
}

/**
 * A compliance exemption filed into the org's EXISTING review queue
 * (`POST /compliance/exemptions`, reviewed by an admin via `PUT /:id/review`).
 * Filing is a write (a pending row + notification), so the agent proposes it.
 */
export interface ExemptionRequestProposal extends ProposalBase {
  kind: 'compliance-exemption-request';
  /** Rule + entity label for the card. */
  target: string;
  /** Exactly the `POST /compliance/exemptions` body — the shared wire contract,
   *  so this proposal cannot drift from what the compliance service accepts. */
  request: ComplianceExemptionRequest;
  commit: CommitTarget;
}

/** Every reviewable draft the Ask agent can emit. */
export type AskProposal =
  | PipelineProposal
  | PluginProposal
  | TemplateProposal
  | EditProposal
  | OrgSettingsProposal
  | InstallChangeProposal
  | ExemptionRequestProposal;

export type ProposalKind = AskProposal['kind'];

/**
 * The tool's uniform "I did not draft it" answer: same envelope, `error` set and
 * nothing else meaningful. The UI renders it as a refusal, not a failed draft.
 */
export interface DeclinedProposal {
  kind: ProposalKind;
  error: string;
  refusedFields: string[];
  provenance: AskProvenance;
}

/** Build a {@link DeclinedProposal}. */
export function declined(kind: ProposalKind, error: string): DeclinedProposal {
  return { kind, error, refusedFields: [], provenance: ASK_PROVENANCE };
}
