// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared contract between the ask agent's PROPOSE tools and the browser's
 * CONFIRM handlers. Two things live here, and they live here because BOTH sides
 * need them: `api/ask` builds its tool schema from this module, the frontend's
 * confirm handler builds its request from it, and the tests of both assert
 * against it. A second copy would be a second policy.
 *
 * Dependency-free on purpose — no runtime imports at all — so the browser can
 * import it through api-core's `./ask-proposals` entry without dragging in the
 * server graph (express / jwt / ioredis). The only imports are `import type`,
 * which the compiler erases.
 *
 * -----------------------------------------------------------------------------
 * 1. PROVENANCE
 * -----------------------------------------------------------------------------
 * Every commit that started life as an agent draft stamps
 * `details: { proposedBy: 'ask-agent' }` onto its audit event. The audit trail
 * is hash-chained and tamper-evident, but without this field it cannot
 * distinguish "the admin changed this" from "an AI drafted it and the admin
 * clicked Apply" — the two mean very different things in an incident review.
 * The constant exists so the literal is not retyped in two codebases, where a
 * typo would silently produce an unqueryable trail.
 *
 * -----------------------------------------------------------------------------
 * 2. THE ORG-SETTINGS ALLOWLIST
 * -----------------------------------------------------------------------------
 * This is an ALLOWLIST, not a denylist, and the distinction is the whole point:
 * a setting added to the platform tomorrow is UNAVAILABLE to the agent until
 * someone deliberately adds it here, rather than being exposed by omission.
 * If you are reading this because a proposal was refused, the fix is to add the
 * field below WITH its `why` — not to loosen {@link pickAllowed}.
 *
 * A field earns a place here only if all of the following hold. They were
 * checked against the routes, not assumed:
 *
 *  - **No step-up.** A route carrying `requireStepUp` is out, no exceptions.
 *    Step-up means the platform already decided a live session is not enough
 *    authority; a chat proposal is strictly less. This is what keeps
 *    `PUT /organization/ai-config` out (it persists per-org provider SECRETS),
 *    along with the MFA / password / authenticator policies,
 *    `PUT /plugins/install-policy`, org restore and transfer-owner.
 *  - **Not a security control.** MFA / password / authenticator / impersonation
 *    policy, SSO+SAML and its group mappings, verified domains and domain-based
 *    join, join-request decisions, transfer-owner and team lifecycle are ABSENT
 *    here rather than gated within — "relax the MFA policy" is precisely what an
 *    injection payload asks for, and it arrives through text the agent already
 *    reads. Absent cannot be argued with; gated can.
 *  - **Carries no secret and no callback target.** An API that returns
 *    `hasWebhookSecret` instead of the secret is telling you the field cannot be
 *    diffed, so it cannot be reviewed, so it cannot be proposed. Webhook URLs
 *    and email addresses are out for the same reason plus one more: they are
 *    exfiltration targets, and a confirmation mail to an attacker-chosen address
 *    is a send the platform performs on the model's say-so.
 *  - **Reviewable as a diff.** A scalar with a closed shape (boolean, bounded
 *    integer, small enum). A list of opaque user ids renders as ids in a card
 *    nobody can check, so recipient LISTS are out even though cadence is in.
 *
 * Each entry names the API that applies it. The browser applies it through the
 * USER's own session and the user's own permissions — the agent never writes —
 * so a proposal a member may not commit simply 403s at the route, exactly as a
 * hand-made request would.
 *
 * Rule 10 lives in {@link pickAllowed}: a candidate carrying a field outside
 * this list is the injection signal, so the refused names come back to the
 * caller to be counted and logged rather than being quietly dropped.
 */

import type { Permission } from './permissions.js';
import type { PluginSecurityDigestMode } from './wire-vocabulary.js';

// -----------------------------------------------------------------------------
// Provenance (rule 6)
// -----------------------------------------------------------------------------

/** The `proposedBy` value every agent-drafted commit records. */
export const ASK_AGENT_PROPOSER = 'ask-agent';

/** The audit `details` key that carries provenance. */
export const PROPOSED_BY_DETAIL_KEY = 'proposedBy';

/** The provenance fragment merged into a `RemoteAuditEvent.details`. */
export interface AskProposalProvenance {
  readonly proposedBy: typeof ASK_AGENT_PROPOSER;
}

/**
 * Merge agent provenance into an audit event's free-form `details`.
 * Provenance is applied LAST so a caller-supplied `proposedBy` cannot overwrite
 * it — the point of the field is that it is not negotiable.
 */
export function askProposalAuditDetails(
  details?: Readonly<Record<string, unknown>>,
): Record<string, unknown> & AskProposalProvenance {
  return { ...details, proposedBy: ASK_AGENT_PROPOSER };
}

// -----------------------------------------------------------------------------
// The allowlist
// -----------------------------------------------------------------------------

/** A value an allowlisted org setting can hold. */
export type OrgSettingValue = string | number | boolean;

/** Which per-org record (and therefore which API) a field belongs to. */
export type OrgSettingSurface =
  | 'reporting'
  | 'complianceNotifications'
  | 'pluginSecurityNotifications';

/**
 * Every proposable setting, as `<surface>.<field>`. Writing the union out by
 * hand (rather than inferring it from the array) is deliberate: the key space
 * is the contract the tool schema and the confirm handler share, so it is
 * stated once, explicitly, and a typo in an entry below is a compile error.
 */
export type OrgSettingKey =
  | 'reporting.incidentWindowHours'
  | 'complianceNotifications.notifyOnBlock'
  | 'complianceNotifications.notifyOnWarning'
  | 'complianceNotifications.emailEnabled'
  | 'complianceNotifications.digestMode'
  | 'pluginSecurityNotifications.notifyRescan'
  | 'pluginSecurityNotifications.digestMode';

/** The closed shape a proposed value must match before it is accepted. */
export type OrgSettingShape =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

/** One proposable org setting. */
export interface OrgSettingSpec {
  /** Stable proposal key — `<surface>.<field>`. This is what the model names. */
  readonly key: OrgSettingKey;
  readonly surface: OrgSettingSurface;
  /** The request-body field name the API expects. */
  readonly field: string;
  readonly shape: OrgSettingShape;
  /** The route that applies it, called by the BROWSER with the user's session. */
  readonly api: { readonly method: 'PUT'; readonly path: string };
  /** The permission that route requires of the caller. */
  readonly permission: Permission;
  /** Short human label for the confirm card. */
  readonly label: string;
  /** WHY this field is safe to propose. Every entry states its own case. */
  readonly why: string;
}

/**
 * The `digestMode` vocabulary is MIRRORED, not imported: this module keeps zero
 * runtime imports so the browser entry stays standalone. The type annotation
 * makes a REMOVED mode a compile error here, and `ask-proposals.test.ts` asserts
 * the list against `PLUGIN_SECURITY_DIGEST_MODES` so an ADDED one cannot drift
 * either.
 */
const DIGEST_MODES: readonly PluginSecurityDigestMode[] = ['immediate', 'daily', 'weekly'];

/**
 * The allowlist. Adding an entry is a deliberate act: name the route you
 * checked, confirm it carries no `requireStepUp`, and write the `why`.
 */
export const ORG_SETTING_PROPOSAL_ALLOWLIST: readonly OrgSettingSpec[] = [
  {
    key: 'reporting.incidentWindowHours',
    surface: 'reporting',
    field: 'incidentWindowHours',
    shape: { kind: 'integer', min: 1, max: 720 },
    api: { method: 'PUT', path: '/reports/settings/incidents' },
    permission: 'org:settings',
    label: 'Incident correlation window (hours)',
    why:
      'Analytics tuning only: it decides how long after a deploy an incident is '
      + 'attributed to that deploy when DORA metrics are computed. It grants nothing, '
      + 'reveals nothing and reaches no one — the worst outcome of a wrong value is a '
      + 'misleading change-failure rate, which the next edit corrects. The route '
      + 'rejects the sibling retention fields outright (they are billing-owned), so '
      + 'this is the whole writable surface. Bounded integer, so the diff is one number.',
  },
  {
    key: 'complianceNotifications.notifyOnBlock',
    surface: 'complianceNotifications',
    field: 'notifyOnBlock',
    shape: { kind: 'boolean' },
    api: { method: 'PUT', path: '/compliance/notification-preferences' },
    permission: 'compliance:write',
    label: 'Notify when compliance blocks an action',
    why:
      'A delivery preference, not an enforcement control: the block happens either '
      + 'way and the policy that caused it is unchanged. Turning it off makes the org '
      + 'quieter, never more permissive.',
  },
  {
    key: 'complianceNotifications.notifyOnWarning',
    surface: 'complianceNotifications',
    field: 'notifyOnWarning',
    shape: { kind: 'boolean' },
    api: { method: 'PUT', path: '/compliance/notification-preferences' },
    permission: 'compliance:write',
    label: 'Notify on compliance warnings',
    why: 'As notifyOnBlock — which non-blocking findings are announced, not what is enforced.',
  },
  {
    key: 'complianceNotifications.emailEnabled',
    surface: 'complianceNotifications',
    field: 'emailEnabled',
    shape: { kind: 'boolean' },
    api: { method: 'PUT', path: '/compliance/notification-preferences' },
    permission: 'compliance:write',
    label: 'Send compliance notices by email',
    why:
      'Chooses whether the existing notices go out by email. It does not name a '
      + 'recipient — the address list is resolved from org membership at send time — '
      + 'so a flipped boolean can never route mail somewhere new.',
  },
  {
    key: 'complianceNotifications.digestMode',
    surface: 'complianceNotifications',
    field: 'digestMode',
    shape: { kind: 'enum', values: DIGEST_MODES },
    api: { method: 'PUT', path: '/compliance/notification-preferences' },
    permission: 'compliance:write',
    label: 'Compliance notice cadence',
    why: 'Cadence of an existing notice to existing recipients. Closed enum, so the diff is one word.',
  },
  {
    key: 'pluginSecurityNotifications.notifyRescan',
    surface: 'pluginSecurityNotifications',
    field: 'notifyRescan',
    shape: { kind: 'boolean' },
    api: { method: 'PUT', path: '/plugins/security-notifications' },
    permission: 'org:settings',
    label: 'Notify on nightly rescan findings',
    why:
      'Governs the N31 rescan notice only. The scan GATES are untouched: a build that '
      + 'trips PLUGIN_VULN_GATE still fails and still sends N30, which this flag cannot '
      + 'suppress. So it changes how noisy an informational notice is, not whether a '
      + 'vulnerable version can be published.',
  },
  {
    key: 'pluginSecurityNotifications.digestMode',
    surface: 'pluginSecurityNotifications',
    field: 'digestMode',
    shape: { kind: 'enum', values: DIGEST_MODES },
    api: { method: 'PUT', path: '/plugins/security-notifications' },
    permission: 'org:settings',
    label: 'Plugin security notice cadence',
    why:
      'Cadence of the rescan notice. N30 ("version blocked") is always immediate and '
      + 'ignores this field, so the urgent channel cannot be slowed down.',
  },
];

/**
 * Fields DELIBERATELY excluded, with the reason, so a future reader does not
 * re-litigate them and a reviewer can see they were considered rather than
 * missed. This is documentation only — {@link pickAllowed} consults the
 * allowlist alone, and a field absent from BOTH lists is refused identically.
 */
export const ORG_SETTING_PROPOSAL_EXCLUSIONS: ReadonlyArray<{ readonly field: string; readonly why: string }> = [
  { field: 'organization.aiConfig', why: 'Step-up gated (PUT /organization/ai-config) and persists per-org provider secrets.' },
  { field: 'organization.mfaPolicy', why: 'Security control + step-up. Loosening it removes a control for every member.' },
  { field: 'organization.passwordPolicy', why: 'Security control + step-up.' },
  { field: 'organization.authenticatorPolicy', why: 'Security control + step-up.' },
  { field: 'organization.impersonationPolicy', why: 'Security control + step-up; decides who outside the org may view its data.' },
  { field: 'organization.idp', why: 'SSO/SAML config: security control on its own capability (org:idp), assurance + strong step-up.' },
  { field: 'organization.kmsConfig', why: 'Key material. Own capability (org:kms), assurance + strong step-up.' },
  { field: 'organization.identity', why: 'Org name/slug: no step-up, but renaming an org is an impersonation primitive and the slug is addressable.' },
  { field: 'organization.domains', why: 'Verified domains drive domain-based join — who may become a member.' },
  { field: 'organization.joinRequests', why: 'Membership decisions are an authority grant, not a setting.' },
  { field: 'organization.transferOwner', why: 'Ownership transfer: security control, MFA-grade + step-up.' },
  { field: 'organization.teams', why: 'Team lifecycle (create/delete/move) is structural and step-up gated.' },
  { field: 'plugins.installPolicy', why: 'Step-up gated (PUT /plugins/install-policy) and decides what may be installed.' },
  { field: '*.webhookUrl', why: 'A callback target: proposing one turns the platform into an exfiltration channel.' },
  { field: '*.webhookSecret', why: 'Bearer-equivalent. The API returns hasWebhookSecret, never the value, so it cannot be diffed.' },
  { field: 'pluginSecurityNotifications.externalEmail', why: 'An address the platform then mails a confirmation link to. Never model-chosen.' },
  { field: '*.targetUsers', why: 'A list of opaque user ids is not reviewable in a card, and redirecting recipients can silence a channel.' },
  { field: 'pluginSecurityNotifications.recipientMode', why: 'Pairs with targetUsers; switching to "users" makes an unreviewable list authoritative.' },
  { field: 'reporting.eventRetentionDays', why: 'Billing-owned (tier + purchased packs). The route already rejects it; admitting it would be an entitlement bypass.' },
  { field: 'reporting.doraRetentionDays', why: 'Billing-owned, as above.' },
];

// -----------------------------------------------------------------------------
// Lookup
// -----------------------------------------------------------------------------

const BY_KEY: ReadonlyMap<string, OrgSettingSpec> =
  new Map(ORG_SETTING_PROPOSAL_ALLOWLIST.map((spec) => [spec.key, spec]));

/** Every proposable key — the enum a propose tool's input schema is built from. */
export const ORG_SETTING_PROPOSAL_KEYS: readonly OrgSettingKey[] =
  ORG_SETTING_PROPOSAL_ALLOWLIST.map((spec) => spec.key);

/** Is `key` on the allowlist? */
export function isProposableOrgSetting(key: string): key is OrgSettingKey {
  return BY_KEY.has(key);
}

/** The spec for `key`, or undefined when it is not proposable. */
export function orgSettingSpec(key: string): OrgSettingSpec | undefined {
  return BY_KEY.get(key);
}

/** Does `value` match the shape the field declares? */
export function isValidOrgSettingValue(spec: OrgSettingSpec, value: unknown): value is OrgSettingValue {
  const shape = spec.shape;
  if (shape.kind === 'boolean') return typeof value === 'boolean';
  if (shape.kind === 'integer') {
    return typeof value === 'number' && Number.isInteger(value) && value >= shape.min && value <= shape.max;
  }
  return typeof value === 'string' && shape.values.includes(value);
}

// -----------------------------------------------------------------------------
// pickAllowed (rules 1, 3 and 10)
// -----------------------------------------------------------------------------

/** A proposal's settings, keyed by allowlist key. */
export type OrgSettingPatch = Partial<Record<OrgSettingKey, OrgSettingValue>>;

/** What {@link pickAllowed} kept, and what it threw away. */
export interface PickAllowedResult {
  /** The allowlisted, shape-valid settings. */
  readonly allowed: OrgSettingPatch;
  /**
   * Field names the candidate carried that are NOT on the allowlist. THIS is
   * the injection signal (rule 10): a legitimate draft has none, so a non-empty
   * list is a counter to increment and a line to log, not a silent drop.
   */
  readonly refused: readonly string[];
  /**
   * Allowlisted keys whose value did not match the declared shape. Dropped too,
   * but reported separately — a bad value is a drafting mistake, not an attempt
   * to reach a field the agent was never given.
   */
  readonly invalid: readonly OrgSettingKey[];
  /** `refused.length`, so a caller can count without re-deriving it. */
  readonly refusedCount: number;
}

/**
 * Keep only the allowlisted, shape-valid fields of a candidate proposal, and
 * report everything dropped.
 *
 * The result's `allowed` map IS the commit payload (rule 3): the confirm
 * handler sends these fields and only these, so anything the model slipped in
 * is structurally unappliable rather than merely unrendered.
 *
 * `candidate` is untrusted model output, so it is read defensively: anything
 * that is not a plain object yields an empty result.
 */
export function pickAllowed(candidate: unknown): PickAllowedResult {
  const allowed: OrgSettingPatch = {};
  const refused: string[] = [];
  const invalid: OrgSettingKey[] = [];

  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
      const spec = BY_KEY.get(key);
      if (!spec) { refused.push(key); continue; }
      if (!isValidOrgSettingValue(spec, value)) { invalid.push(spec.key); continue; }
      allowed[spec.key] = value;
    }
  }

  return { allowed, refused, invalid, refusedCount: refused.length };
}

// -----------------------------------------------------------------------------
// Diff + request planning (rules 3 and 7)
// -----------------------------------------------------------------------------

/** One reviewed change: what the setting is now, and what it would become. */
export interface OrgSettingChange {
  readonly spec: OrgSettingSpec;
  readonly from: OrgSettingValue | undefined;
  readonly to: OrgSettingValue;
}

/**
 * The changes a proposal actually makes, given the CURRENT values. A field
 * whose proposed value already equals the current one is dropped — it is not a
 * change, and rendering it as one makes a diff the user cannot read.
 *
 * The confirm handler re-runs this against a FRESH read immediately before
 * committing (rule 7): these records carry no version column, so if the list
 * that comes back differs from the one the user approved, state moved under the
 * proposal and the commit must be refused rather than applied blind.
 */
export function diffOrgSettings(
  current: Readonly<OrgSettingPatch>,
  proposed: Readonly<OrgSettingPatch>,
): readonly OrgSettingChange[] {
  const changes: OrgSettingChange[] = [];
  for (const spec of ORG_SETTING_PROPOSAL_ALLOWLIST) {
    const to = proposed[spec.key];
    if (to === undefined) continue;
    const from = current[spec.key];
    if (from === to) continue;
    changes.push({ spec, from, to });
  }
  return changes;
}

/** One API call the confirm handler makes: one surface, one body. */
export interface OrgSettingRequest {
  readonly surface: OrgSettingSurface;
  readonly method: 'PUT';
  readonly path: string;
  readonly permission: Permission;
  /** Request body: the API's own field names, carrying only reviewed values. */
  readonly body: Record<string, OrgSettingValue>;
}

/**
 * Group approved changes into one request per surface, translating proposal
 * keys back to the field names each API expects. Order follows the allowlist,
 * so the same proposal always produces the same call sequence.
 */
export function orgSettingRequests(changes: readonly OrgSettingChange[]): readonly OrgSettingRequest[] {
  const bySurface = new Map<OrgSettingSurface, OrgSettingRequest>();
  for (const spec of ORG_SETTING_PROPOSAL_ALLOWLIST) {
    const change = changes.find((c) => c.spec.key === spec.key);
    if (!change) continue;
    const existing = bySurface.get(spec.surface);
    if (existing) {
      existing.body[spec.field] = change.to;
      continue;
    }
    bySurface.set(spec.surface, {
      surface: spec.surface,
      method: spec.api.method,
      path: spec.api.path,
      permission: spec.permission,
      body: { [spec.field]: change.to },
    });
  }
  return [...bySurface.values()];
}
