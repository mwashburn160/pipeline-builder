// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document } from 'mongoose';
import { config } from '../config/index.js';

/**
 * Audit event action categories.
 *
 * Only includes actions actually emitted by `helpers/audit.ts` callers today.
 * Add a value here AND wire the corresponding `audit(req, '<name>',...)`
 * call in the controller  declaring the value alone produces a dead surface
 * that misleads dashboard filters.
 */
/**
 * Every audit action the platform emits, as a runtime list.
 *
 * This is the SINGLE source: {@link AuditAction} is derived from it below. It
 * used to be a hand-maintained mirror of a separately-declared union — ~150
 * lines duplicated, kept honest by a `satisfies` clause plus a `_MissingAction`
 * assertion, i.e. machinery whose only job was policing a seam that didn't need
 * to exist. The array has to be the source because a TypeScript union is erased
 * at runtime and cannot be enumerated.
 *
 * Only includes actions actually emitted by `helpers/audit.ts` callers today.
 * Add a value here AND wire the corresponding `audit(req, '<name>', ...)` call
 * in the controller — declaring the value alone produces a dead surface that
 * misleads dashboard filters.
 *
 * NOTE: the `POST /audit/events` ingest validator does NOT use this list; it
 * gates on api-core's `isRemoteAuditAction` (the remote-emittable SUBSET).
 * `test/audit-remote-subset.test.ts` asserts that subset is contained here.
 */
export const ALL_AUDIT_ACTIONS = [
  // User lifecycle (controllers/auth.ts, controllers/user-profile.ts)
  'user.register',
  'user.login',
  'user.login.failed',
  'user.logout',
  'user.delete',
  'user.profile.update',
  'user.password.change',
  // Admin/superadmin self-verified their email directly (bypassing the emailed
  // verification link). Recorded because it skips proof-of-ownership.
  'user.email.verified',
  'user.onboarding.complete',
  'user.token.create',
  'user.tokens.revoke-all',
  // One session slot revoked from the sessions-and-devices page: a signed-in
  // device, or a stored machine credential that stops renewing. `details`
  // carries the slot id + kind.
  'user.session.revoke',
  // A successful step-up re-verification (controllers/step-up*.ts,
  // controllers/webauthn.ts). `details.method` is 'password', 'webauthn' or
  // 'reauth' (+ `provider`/`kind`/`recencyVerified` for re-auth).
  // Failures are recorded as `user.login.failed` with `targetType: 'step-up'`.
  'user.step-up',
  // Passkeys (WebAuthn, controllers/webauthn.ts). A passkey is a persistent
  // sign-in credential, so both ends of its life are recorded; `details.name` is
  // the label the person gave it and `details.backedUp` says whether it is a
  // synced credential. `.rename` is included because the label is what a person
  // recognises a credential by when deciding which to revoke.
  'user.passkey.register',
  'user.passkey.rename',
  'user.passkey.remove',
  // The authenticator's signature counter went BACKWARDS on a credential that
  // had counted before — two authenticators answering for one credential, i.e. a
  // clone. The assertion is refused; this is the only trace it happened.
  'user.passkey.clone_suspected',
  // Authenticator app (TOTP, controllers/totp.ts). `.enrol` is emitted twice —
  // `details.stage: 'started'` when the secret is minted and `'activated'` when a
  // code confirms it — because a secret that was displayed and then abandoned is
  // still a secret that left the building. `.disable` is the other end of the
  // factor's life. Failed codes are `user.login.failed` with `details.method:
  // 'totp'`, so brute-force shows up on the same trail as password guessing.
  'user.totp.enrol',
  'user.totp.disable',
  // The recovery-code sheet was replaced — every previously issued code stops
  // working, so a regeneration nobody remembers doing is worth seeing.
  'user.totp.recovery_regenerate',
  // A recovery code was SPENT (sign-in or step-up). Its own action rather than a
  // detail on the login, because burning one usually means a lost device — and
  // an attacker who obtained the sheet leaves exactly this trace.
  'user.totp.recovery_used',
  // Opaque access keys (`pb_pat_…`) — create / revoke, and the exchange that
  // turns one into a 5-minute JWT. `user.key.exchange` is the ONLY record that a
  // key was used at all (services never see the key itself), so it is what
  // "which automation is still using key X" is answered from; the failure twin
  // carries the refusal reason the caller is deliberately not told.
  'user.key.create',
  'user.key.revoke',
  'user.key.exchange',
  'user.key.exchange.failed',
  // Device authorization grant (controllers/device-auth.ts) — how the CLI signs
  // in without ever holding a password. `.start` is PRE-AUTH (actor 'anonymous';
  // `details.client` is the requesting device), the rest carry the approver.
  // `targetId` is the flow's correlation handle, so start → approve/deny join up;
  // `.expire` is emitted by whichever side first observes a lapsed code, so a
  // code nobody ever comes back to leaves only its `.start`.
  'device.authorize.start',
  'device.authorize.approve',
  'device.authorize.deny',
  'device.authorize.expire',
  // Organization (controllers/organization.ts)
  'org.create',
  // Owner/admin self-serve org identity edit (name/slug). `affectedOrgId` is
  // the org changed; `details` carries the fields that were updated.
  'org.update',
  // Domain-based org join (P2b): domain register/verify/mode/delete + join
  // request lifecycle. `affectedOrgId` is the org; `details` carries the domain
  // or the requesting/decided user.
  'org.domain.add',
  'org.domain.verify',
  'org.domain.mode',
  'org.domain.delete',
  'org.join.request',
  'org.join.auto',
  'org.join.approve',
  'org.join.deny',
  // Org SOFT-DELETE / restore lifecycle (controllers/organization.ts).
  // `org.soft_delete` is emitted when a sysadmin runs DELETE — the org enters
  // its retention window (snapshot taken, sessions cut) instead of being
  // hard-deleted; `details` carries the `purgeAfter` deadline. `org.restore`
  // reverses it within the window. The eventual hard delete is still the
  // `admin.org.delete` event emitted by the purge sweep.
  'org.soft_delete',
  'org.restore',
  // Organization membership mutations (controllers/organization-members.ts).
  // `affectedOrgId` carries the org being mutated; `targetId` is the user
  // being added/removed/modified. Privilege changes are surfaced separately
  // from the per-org operations so reviewers can filter on "who became owner
  // of what, when".
  'org.member.add',
  'org.member.remove',
  'org.member.deactivate',
  'org.member.activate',
  'org.ownership.transfer',
  // Invitation lifecycle (controllers/invitation.ts). `accept` creates a
  // membership — a self-serve privilege grant / the primary org-join path — so
  // the whole lifecycle is audited alongside the other membership mutations.
  // `affectedOrgId` is the invitation's org; `details` carries the invited email/role.
  'invitation.send',
  'invitation.accept',
  'invitation.revoke',
  'invitation.resend',
  // Active-org context switch (controllers/auth.ts switchOrg) — records which org
  // the actor pivoted their session into.
  'org.switch',
  // Permission-role assignment mutations (controllers/organization-roles.ts).
  // `affectedOrgId` is the org; `targetId` is the user added/removed; `details`
  // carries the role name + the coarse role it grants. Adding to Admin or
  // Super Admin is a privilege escalation, so these are surfaced distinctly.
  'org.role.member.add',
  'org.role.member.remove',
  'org.role.create',
  'org.role.update',
  'org.role.delete',
  // Org service accounts (controllers/service-accounts.ts) — non-human
  // principals and their `pb_sa_…` keys. `affectedOrgId` is the owning org and
  // `targetId` the account; `details` carries the name, the Role set and (for a
  // key) its lifetime + whether an IP allowlist was set. Minting a machine
  // credential is a durable privilege grant, so create/update/delete and every
  // key issue/revoke are audited distinctly from the roster events above. The
  // account itself is the ACTOR of everything the key then does (see
  // `user.key.exchange`, whose `details.principalType` says which kind of
  // principal exchanged).
  'org.service-account.create',
  'org.service-account.update',
  'org.service-account.delete',
  'org.service-account.key.create',
  'org.service-account.key.revoke',
  // Self-rotation (#N2): a live `pb_sa_` key mints its own replacement, and
  // then retires its predecessor. Attributed to the ACCOUNT, not to a person —
  // no human is present when an unattended rotator runs.
  'org.service-account.key.rotate',
  'org.service-account.key.rotate.failed',
  // Admin actions (controllers/user-admin.ts)
  'admin.user.create',
  // Admin edit of ANOTHER user via PUT /users/:id — role/email/password/org
  // changes. `details.changes` carries the field NAMES that changed (never the
  // password value or any secret); `affectedOrgId` is the target's org. A
  // privileged account-takeover (admin resets a victim's password / elevates
  // their role) must leave this trail.
  'admin.user.update',
  'admin.user.delete',
  'admin.org.delete',
  // GDPR portability export. Emitted from controllers/organization.ts
  // when a sysadmin downloads an org's full data dump (before deletion or
  // on customer request).
  'admin.org.export',
  // Dashboards (controllers/dashboards.ts)
  'dashboard.create',
  'dashboard.update',
  'dashboard.delete',
  'dashboard.restore',
  'dashboard.clone',
  // Alert destinations (controllers/alert-destinations.ts)
  'alert.destination.create',
  'alert.destination.update',
  'alert.destination.delete',
  'alert.destination.restore',
  'alert.destination.test',
  // per-org operator-authored alert rules (controllers/alert-rules.ts).
  'alert.rule.create',
  'alert.rule.update',
  'alert.rule.delete',
  'alert.rule.restore',
  // per-org IdP config (controllers/org-idp.ts). Sysadmin-only setup.
  'admin.org-idp.upsert',
  'admin.org-idp.delete',
  // IdP group → Role mapping (3a, controllers/org-idp-mappings.ts). Authoring a
  // rule is a standing privilege grant — everyone the IdP puts in that group
  // receives the Roles from their next sign-in — so create/update and delete are
  // audited like a Role assignment. `affectedOrgId` is the org; `details` carries
  // the group and the Role ids.
  'org.idp.mapping.upsert',
  'org.idp.mapping.delete',
  // SCIM 2.0 provisioning (3b, controllers/scim.ts). EVERY SCIM change is
  // recorded: the actor is the service account behind the `scim`-scoped key, and
  // `details.changed` names the attributes that moved (never their values — a
  // directory sync carries personal data and the audit log must not become a
  // second copy of it). `.refused` is the failure side: a create turned away for
  // seats, a write refused after an entitlement downgrade, an unsupported filter —
  // `details.reason` is the stable label, and it is what makes a directory sync
  // that has quietly stopped working visible here rather than only in the IdP's
  // own console. `targetId` is the user (Users) or the group mapping (Groups).
  'org.scim.user.create',
  'org.scim.user.update',
  'org.scim.user.activate',
  'org.scim.user.deactivate',
  'org.scim.user.delete',
  'org.scim.group.create',
  'org.scim.group.update',
  'org.scim.group.members',
  'org.scim.group.delete',
  'org.scim.refused',
  // Just-in-time provisioning at SSO sign-in (3a, controllers/sso.ts).
  // `.provision` is emitted when the sign-in CREATES the org membership,
  // `.role.change` when a later sign-in adds/removes mapped Roles, and
  // `.refused` when provisioning was turned away (today: the pooled seat cap —
  // `details.reason`). `targetId` is the user, `affectedOrgId` the SSO org.
  'sso.jit.provision',
  'sso.jit.role.change',
  'sso.jit.refused',
  // Sysadmin authority grants/revokes. The bootstrap path
  // (BOOTSTRAP_SUPERADMIN_EMAILS) emits `grant`; the admin endpoint emits
  // both. `actorId='bootstrap-env'` for env-driven promotions — operators
  // reading the audit log can tell at a glance whether sysadmin authority
  // was granted by an interactive flow (actorId is a user) or by deploy-
  // time configuration.
  'admin.superadmin.grant',
  'admin.superadmin.revoke',
  // Per-org KMS config admin endpoint. `upsert` covers both first set and
  // rotation; `delete` clears the config and reverts the org to the shared
  // master fallback. Both emit `affectedOrgId` for cross-org filtering.
  'admin.org.kms-config.upsert',
  'admin.org.kms-config.delete',
  // Emitted by the org-delete cascade when the deleted org had a per-org KMS
  // CMK (`kmsConfig`). Auto-deleting a CMK is IRREVERSIBLE, so the cascade
  // does NOT schedule the key for deletion — it records this operator-
  // actionable event (with the org id + key identifier in `details`) so an
  // operator can manually schedule the external AWS key's deletion. Without
  // it the key (and anything wrapped under it) silently orphans.
  'org.kms.orphaned',
  // Org tier change. Emitted when a sysadmin moves an org between
  // pricing tiers (developer/pro/team/enterprise); reseeds quota limits as a
  // side-effect. `details` carries the previousTier so the transition
  // is reconstructable from the audit log alone.
  'admin.org.tier.update',
  // Account seat-limit / entitlement sync on the org root (from billing or a
  // sysadmin). `details` carries the new seat cap (+ any feature bundles).
  'admin.org.seatLimit.update',
  // Sysadmin impersonation. `admin.impersonate.start` is emitted when
  // a read-only impersonation token is issued; the `impersonatorId` in
  // details + `targetId` (the impersonated user) tell reviewers who
  // viewed-as-whom. Read-only — no destructive actions can land under
  // the impersonation token, so a single "start" event covers the
  // session (no stop event needed; the token TTL bounds the window).
  // RETAINED DELIBERATELY. Superseded by the lifecycle actions below, but audit
  // history is immutable and hash-chained: events already written with this
  // action must stay readable and chain-verifiable. Removing the value would
  // break `/audit/verify` over historical records. This is data compatibility,
  // not a compatibility shim — do not "clean it up".
  'admin.impersonate.start',
  // Impersonation request lifecycle. `request` is emitted when a session is
  // asked for, `approve`/`deny` when someone decides one, `revoke` when a live
  // session is ended early, and `breakglass` when emergency access is taken over
  // a consent requirement. Each carries the requestId in `details` so the event
  // and the record that holds the full decision can be tied together.
  'admin.impersonate.request',
  'admin.impersonate.approve',
  'admin.impersonate.deny',
  'admin.impersonate.revoke',
  'admin.impersonate.breakglass',
  // Per-org k8s namespace manifest render. Operator-driven provisioning
  // for enterprise-tier customers — emitted whenever a sysadmin downloads
  // the namespace YAML to apply with kubectl. Tracks "this org got its
  // own namespace at <time> by <sysadmin>".
  'admin.org.namespace.render',
  // Plugin builds — emitted by the plugin build worker
  // (api/plugin/src/queue/plugin-build-queue.ts) and posted to the
  // `POST /audit/events` ingest endpoint on platform, which authenticates
  // the worker via service-to-service JWT and persists them here.
  'plugin.build.completed',
  'plugin.build.failed',
  'plugin.build.timeout',
  // Operator-driven re-runs of a build (`plugin.build.retry`) or of a
  // dead-lettered job (`plugin.dlq.replay`) — mutations on the caller's
  // authority, emitted remotely like the outcomes above.
  'plugin.build.retry',
  'plugin.dlq.replay',
  // Pipeline mutations — emitted by api/pipeline's route handlers and posted
  // to the `POST /audit/events` ingest (authenticated via service-to-service
  // JWT). `targetId` is the pipeline id; `orgId` is the caller's org.
  // create/update/delete cover the CRUD surface; execution.start /
  // execution.cancel are the AWS CodePipeline run/cancel path (highest value —
  // they drive real infra actions).
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.restore',
  'pipeline.purge',
  'pipeline_template.create',
  'pipeline_template.update',
  'pipeline_template.delete',
  'pipeline_template.restore',
  'pipeline_template.purge',
  'pipeline.execution.start',
  'pipeline.execution.cancel',
  'pipeline.registry.register',
  'pipeline.registry.deregister',
  // Plugin lifecycle mutations (api/plugin) — the delete/upload/deploy surface
  // that complements the already-audited builds. Posted to the ingest.
  'plugin.delete',
  'plugin.restore',
  'plugin.purge',
  'plugin.update',
  'plugin.upload',
  'plugin.deploy',
  'plugin.bulk.update',
  'plugin.bulk.delete',
  'plugin.dlq.purge',
  // Quota administration (api/quota) — superadmin usage-counter reset and tier
  // limit edits. `affectedOrgId` is the org changed.
  'quota.reset',
  'quota.limit.update',
  'quota.delete',
  // Compliance rule administration (api/compliance) — exemption approval, rule
  // active toggle, and scan cancellation.
  'compliance.exemption.approve',
  'compliance.exemption.revoke',
  'compliance.rule.toggle',
  'compliance.rule.create',
  'compliance.rule.update',
  'compliance.rule.delete',
  'compliance.rule.restore',
  'compliance.rule.purge',
  'compliance.policy.create',
  'compliance.policy.update',
  'compliance.policy.delete',
  'compliance.policy.restore',
  'compliance.policy.purge',
  'compliance.scan-schedule.create',
  'compliance.scan-schedule.update',
  'compliance.scan-schedule.delete',
  'compliance.template.apply',
  'compliance.scan.cancel',
  'compliance.scan.create',
  // Per-user compliance notification preferences (api/compliance).
  'compliance.notification-preference.update',
  // Image-registry destructive ops (api/image-registry) — GC sweeps + explicit
  // image/tag deletes.
  'registry.gc',
  'registry.image.delete',
  'registry.image.copy',
  // Messaging (api/message) — admin broadcast announcements + destructive
  // deletes (metadata only, never message body content).
  'message.announcement.create',
  'message.delete',
  'message.restore',
  'message.purge',
  // Billing (api/billing) — subscription + entitlement mutations, mirrored to
  // the central trail (also in the service-local billing_events collection).
  // Customer-driven subscription lifecycle (the admin counterpart is
  // `billing.tier.override`): self-serve create (direct or Marketplace claim),
  // plan/interval change, cancel-at-period-end, undo-cancel, cascade delete.
  'billing.subscription.create',
  'billing.subscription.update',
  'billing.subscription.reactivate',
  'billing.subscription.cancel',
  'billing.subscription.delete',
  'billing.tier.override',
  // Operator-only reseed of the invoice ledger from the payment provider's
  // invoice history (POST /billing/admin/backfill).
  'billing.ledger.backfill',
  'billing.addon.add',
  'billing.addon.remove',
  'billing.addon.prune',
  // Discounts (docs/billing-discounts.md) — coupon/usage-credit mint, issue,
  // apply, remove, revoke. `details` carry the discount id + kind/value only,
  // never the opaque token or signing key.
  'billing.discount.generate',
  'billing.discount.issue',
  'billing.discount.apply',
  'billing.discount.remove',
  'billing.discount.revoke',
  // Promotions — rule-driven auto-grant campaigns (docs/billing-discounts.md#promotions).
  'billing.promotion.create',
  'billing.promotion.update',
  'billing.promotion.revoke',
  'billing.promotion.grant',
  'billing.promotion.activate',
  // Usage-credit realization — credit consumed (Marketplace metered drawdown),
  // exhausted (balance hit zero), and a combo ending. `details` carry cents/ids only.
  'billing.credit.consumed',
  'billing.credit.exhausted',
  'billing.combo.expired',
  // Reporting (api/reporting) — per-org reporting config, a post-deploy outcome
  // marker (moves the org's DORA CFR/MTTR), and the inbound billing→reporting
  // retention-entitlement sync. Ingested via `POST /audit/events`.
  'reporting.settings.update',
  'reporting.deployment.outcome',
  'reporting.retention.sync',
  // Denied authorization attempt — best-effort emission from the shared
  // requirePermission / requireSystemAdmin gate on a rejected state-changing
  // request (probing/escalation signal). `outcome` is 'failure'.
  'authz.denied',
  'observability.silence.create',
  'observability.silence.delete',
  // Platform admin mutations that were previously unaudited (controllers).
  // `admin.org.ai-config.update` — org AI-provider config (holds provider API
  //   keys; details carry field NAMES only, never a key value).
  // `admin.org.quota.override` — a sysadmin manual quota limit/usage override.
  // `admin.user.features.update` — a sysadmin editing a user's feature overrides.
  'admin.org.ai-config.update',
  'admin.org.quota.override',
  'admin.user.features.update',
  // "Ask" assistant (api/ask) — safe metadata only (tools used, proposal kinds,
  // query length, outcome), never the raw query text. `ask.query` = read-only
  // how-to turn; `ask.agent.turn` = tool-calling turn.
  'ask.query',
  'ask.agent.turn',
] as const;

/**
 * Union of every audit action, derived from {@link ALL_AUDIT_ACTIONS} so the two
 * can never disagree.
 */
export type AuditAction = (typeof ALL_AUDIT_ACTIONS)[number];


/**
 * Audit event document stored in MongoDB.
 *
 * Field semantics * - `orgId`  actor's JWT-claimed org at the time of the action.
 * - `affectedOrgId`  the org that was OPERATED ON. Same as `orgId` for
 * normal in-org actions. When a sysadmin (whose `orgId`
 * is the system org) touches another org's resources,
 * `affectedOrgId` carries the impacted org so the audit
 * log answers "what did a sysadmin do to org X?".
 * Required for SOC2 evidence on impersonation-style
 * access.
 */
export interface AuditEventDocument extends Document {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  /** Actor's per-org role at action time ('owner' | 'admin' | 'member'). */
  actorRole?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  /** Permission role involved (org.role.* actions). Promoted out of
   *  `details` so reviewers can filter "who touched role X". Field name kept
   *  as `groupId` for audit-log backward compatibility. */
  groupId?: string;
  /** Sysadmin who initiated an impersonation session, when the actor is
   *  acting under an impersonation token. Lets reviewers unmask "viewed-as". */
  impersonatorId?: string;
  /** Did the action succeed or fail? Defaults to 'success'; failure-path
   *  call sites (login.failed, plugin.build.failed/timeout) pass 'failure'. */
  outcome?: 'success' | 'failure';
  details?: Record<string, unknown>;
  ip?: string;
  /** Client User-Agent (truncated + control-chars stripped). Forensic signal
   *  for correlating an action to a device/session. */
  userAgent?: string;
  /** Correlation id (nginx `x-request-id`, or generated). Ties the event to
   *  its HTTP request and to structured log lines for the same request. */
  requestId?: string;
  /** Distributed trace id (OpenTelemetry active span) when tracing is on.
   *  Correlates the action across services end-to-end. */
  traceId?: string;
  /** TAMPER-EVIDENCE: SHA-256 digest of this event's immutable fields plus
   *  `prevHash` (see `helpers/audit-chain.ts`). Lets a verifier detect any
   *  post-hoc mutation of a stored row. */
  hash?: string;
  /** TAMPER-EVIDENCE: the `hash` of the most recent PRIOR event in the same
   *  per-tenant chain (chain key = `affectedOrgId ?? orgId`), or `null` for the
   *  first event in a chain. A missing/re-pointed link reveals a deleted or
   *  reordered row. */
  prevHash?: string | null;
  /** DEDUP: the stable `Idempotency-Key` the remote-audit client stamps on each
   *  emission (and reuses across its 5xx/timeout retries). Constrained by a
   *  UNIQUE SPARSE index so a re-delivered event collides at the DB — even
   *  across replicas — instead of writing a duplicate row / chain link. Only
   *  events that carry a key are constrained (sparse skips the rest). */
  idempotencyKey?: string;
  /** DISPLAY-ONLY: the ISO-8601 instant the action ACTUALLY happened, as
   *  stamped by the remote-audit client at emission time. Differs from
   *  `createdAt` (ingest time) when the client spooled the event through a
   *  platform outage and re-delivered it later. Stored purely for reviewers;
   *  it is deliberately NOT the chain-ordering field and is NOT part of the
   *  tamper-evidence hash — the chain still orders/appends by ingest
   *  `createdAt`, so a spool-delayed re-delivery chains in ingest order.
   *  Reviewers fall back to `createdAt` when it is unset. */
  occurredAt?: Date;
  createdAt: Date;
}

const auditEventSchema = new Schema<AuditEventDocument>( {
  action: { type: String, required: true, index: true },
  actorId: { type: String, required: true, index: true },
  actorEmail: { type: String },
  actorRole: { type: String },
  orgId: { type: String, index: true },
  affectedOrgId: { type: String, index: true },
  targetType: { type: String },
  targetId: { type: String, index: true },
  // Sparse: only group/impersonation/correlation events set these, so the
  // index skips the (vast majority of) documents that leave them unset.
  groupId: { type: String, index: { sparse: true } },
  impersonatorId: { type: String, index: { sparse: true } },
  outcome: { type: String, enum: ['success', 'failure'] },
  details: { type: Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  requestId: { type: String, index: { sparse: true } },
  traceId: { type: String },
  // TAMPER-EVIDENCE hash chain (see helpers/audit-chain.ts). Deliberately NOT
  // `required`: the append path is best-effort, so a hash/chain failure must
  // still be able to write the row rather than reject it. The tail lookup that
  // reads the chain's newest hash is served by the existing
  // `{ affectedOrgId: 1, createdAt: -1 }` compound index below (the stored
  // `affectedOrgId` always equals the chain key), so no extra index is needed.
  hash: { type: String },
  prevHash: { type: String, default: null },
  idempotencyKey: { type: String },
  // DISPLAY-ONLY emission timestamp (see the interface field). A PLAIN stored
  // field: deliberately NO index — indexing it would invite using it as a
  // sort/ordering key, but the tamper-evident chain must keep ordering by
  // ingest `createdAt`. It is not part of the hashed field set either, so a
  // spool-delayed value never perturbs the chain.
  occurredAt: { type: Date },
},
{
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'audit_events',
},
);

// Compound indexes for org-scoped queries sorted by time. Both
// `orgId` (actor's org) and `affectedOrgId` (the operated-on org) get one
//  the "what did sysadmins do to my org" query filters on affectedOrgId.
auditEventSchema.index({ orgId: 1, createdAt: -1 });
auditEventSchema.index({ affectedOrgId: 1, createdAt: -1 });

// DEDUP backstop — UNIQUE + SPARSE on the ingest idempotency key. Sparse so only
// the (minority of) events that carry a key are constrained; unique so a
// re-delivered emission (same key) collides at the DB with an E11000, even
// across replicas, letting the append path treat it as already-stored instead of
// writing a duplicate row / extending the chain twice.
auditEventSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

// CHAIN-LINK uniqueness — UNIQUE on (affectedOrgId, prevHash). Each event links to
// exactly one predecessor via `prevHash`, so within a chain (a given affectedOrgId)
// no two events may share a `prevHash`. Under multi-replica appends two workers can
// read the same tail and try to write two events with the same prevHash — a chain
// FORK that voids tamper-evidence. This index makes the second write collide (E11000)
// so the append path re-reads the now-advanced tail and retries, turning the append
// into a cross-process compare-and-set. (Fresh-install invariant: a pre-existing
// forked collection must be de-duped before this unique index can build.)
auditEventSchema.index({ affectedOrgId: 1, prevHash: 1 }, { unique: true });

// TTL index — auto-delete events after `config.audit.retentionDays` days
// (default 90, overridable via AUDIT_RETENTION_DAYS at boot). Reading from
// `config` keeps the env-parse in one place.
auditEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: config.audit.retentionDays * 86400 },
);

export default model<AuditEventDocument>('AuditEvent', auditEventSchema);
