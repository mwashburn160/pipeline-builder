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
  // The account's recovery-code set (one per account, shared by passkeys and the
  // authenticator app — controllers/recovery-codes.ts) was replaced: every
  // previously issued code stops working, so a regeneration nobody remembers
  // doing is worth seeing.
  'user.mfa.recovery_regenerate',
  // A recovery code was SPENT (sign-in or step-up). Its own action rather than a
  // detail on the login, because burning one usually means a lost device — and
  // an attacker who obtained the sheet leaves exactly this trace.
  'user.mfa.recovery_used',
  // The PASSWORD-ONLY PROMPT (controllers/mfa-nudge.ts): the account was offered
  // a second factor and said no. `prompt_declined` is a durable decision to stay
  // on one factor — the org's admins see the COUNT of people who made it, and
  // this is the only trail that says WHO — and `prompt_restored` is the same
  // person withdrawing it, without which "declined" would read as permanent.
  // The 7-day "not now" is deliberately NOT audited: at a row a week per
  // password-only account it would bury both of these.
  'user.mfa.prompt_declined',
  'user.mfa.prompt_restored',
  // Assurance levels and required MFA (#8, helpers/bootstrap-admin.ts +
  // controllers/org-mfa-policy.ts).
  //
  // `bootstrap_session` is emitted on EVERY sign-in that uses the bootstrap-admin
  // exception — the narrow, self-closing window in which the install's only
  // admin may hold an `aal: 1` session before enrolling a factor. `details.late`
  // is true when it happened more than 24h after the install, which is the
  // alertable case: a fresh install finishes in minutes, so a late one is either
  // a stalled setup or someone using the exception as a way in.
  'auth.mfa.bootstrap_session',
  // The exception closed, permanently, because a factor was enrolled.
  'auth.mfa.bootstrap_closed',
  // An operator reset every factor on an account from the database
  // (`scripts/mfa-recover.ts`) — for when nobody can sign in to do it over HTTP.
  // The operator name is self-asserted (`details.operatorAsserted`). Ends every
  // session and grants the per-user enrolment grace (`details.graceUntil`).
  'auth.mfa.operator_reset',
  // The TWO-PERSON MFA reset (controllers/mfa-reset.ts). `reset_requested`: an
  // org admin asked for a member's factors to be reset (`details.reason`,
  // `details.requestId`). `reset_approved`: a DIFFERENT admin (or a sysadmin)
  // approved it and the reset ran — every factor and the recovery codes
  // removed, every session ended, a per-user enrolment grace granted
  // (`details.graceUntil`); the actor is the approver, `details.requestedBy` the
  // requester. `reset_denied`: denied, or withdrawn by its requester
  // (`details.withdrawn`).
  'auth.mfa.reset_requested',
  'auth.mfa.reset_approved',
  'auth.mfa.reset_denied',
  // A sysadmin reset a member's factors DIRECTLY — the single-person path for an
  // org with no second admin to approve (`details.direct: true`,
  // `details.reason`). Same effect as an approved reset.
  'auth.mfa.direct_reset',
  // An org turned "require MFA" on or off, or changed its grace period / its
  // statement that its IdP enforces MFA / its "administrative actions require
  // MFA" policy (`details.sessionsRefreshed`: members whose sessions were ended
  // so turning it ON applies at once; turning it off ends none). `details`
  // carries both sides — the transition is what a reviewer needs, not the end
  // state.
  'org.mfa_policy.update',
  // An org changed its password policy (minimum length) or its authenticator
  // (passkey model / AAGUID) allowlist. `details` carries both sides.
  'org.password_policy.update',
  'org.authenticator_policy.update',
  // A password sign-in whose password no longer meets the person's org policy
  // opened NO session: a forced password change was required instead
  // (`details.minLength`), and completed by `user.password.change`.
  'user.password.change_required',
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
  // A parent-org admin soft-deleted one of its own teams (DELETE
  // /organization/:id/teams/:teamId) — same retention window as
  // `org.soft_delete`; `details.parentOrgId` names the parent it was deleted from.
  'org.team.delete',
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
  // Sysadmin reparent (POST /organization/:id/move): `details` carries
  // `fromParentOrgId` / `toParentOrgId` (null = standalone root), the resulting
  // tier and how many sessions scoped to the org were invalidated.
  'admin.org.move',
  // GDPR portability export. Emitted from controllers/organization.ts
  // when a sysadmin downloads an org's full data dump (before deletion or
  // on customer request).
  'admin.org.export',
  // Dashboards (controllers/dashboards.ts)
  'dashboard.create',
  'dashboard.update',
  'dashboard.delete',
  'dashboard.restore',
  // Permanent hard-delete of a dashboard tombstone ahead of the retention sweep
  // (the delete it finalizes is already recorded; this records who made it
  // irreversible, and when).
  'dashboard.purge',
  'dashboard.clone',
  // Alert destinations (controllers/alert-destinations.ts)
  'alert.destination.create',
  'alert.destination.update',
  'alert.destination.delete',
  'alert.destination.restore',
  'alert.destination.purge',
  'alert.destination.test',
  // per-org operator-authored alert rules (controllers/alert-rules.ts).
  'alert.rule.create',
  'alert.rule.update',
  'alert.rule.delete',
  'alert.rule.restore',
  'alert.rule.purge',
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
  // SAML 2.0 sign-in (#4, controllers/saml.ts). A successful SAML sign-in is a
  // plain `user.login` with `details.method = 'saml'` — it is the same kind of
  // session, and splitting it would fracture every "who signed in" query. What
  // gets its OWN action is the REFUSAL, because SAML has failure modes that are
  // security events in their own right rather than someone mistyping a password:
  // `details.reason` is `idp_initiated` (an unsolicited assertion — login CSRF),
  // `replay` (an assertion presented twice), `invalid_assertion` (signature,
  // audience, issuer or time), `domain_not_verified`, `platform_admin`,
  // `seat_limit`, and the configuration states. `affectedOrgId` is the SSO org.
  'sso.saml.refused',
  // The org's trusted IdP signing certificates changed. Recorded separately from
  // the surrounding config write because a certificate swap is the one IdP edit
  // that silently decides whose assertions this org will accept — `details`
  // carries how many certificates were trusted before and after, and their
  // fingerprints, never the certificates themselves.
  'sso.saml.certificate.rotate',
  // SAML Single Logout (controllers/saml-slo.ts). `details.direction` is `sp`
  // (we sent the LogoutRequest — `stage: 'request'`, then `'complete'` when the
  // IdP's signed LogoutResponse comes back) or `idp` (the IdP sent a signed
  // LogoutRequest; `sessionsRevoked` counts the platform sessions ended). A
  // refused message is `outcome: 'failure'` with `details.reason`.
  'sso.saml.logout',
  // Test connection (controllers/sso-test.ts) — a DRY RUN of the org's IdP that
  // never creates a session, user or membership. Emitted at `stage: 'start'` and
  // `stage: 'complete'`; the latter carries `ok`, the failure `reason`, the
  // asserted email and whether it was `recorded` as the config's last test.
  'sso.test',
  // The org's "SSO required" policy was switched on or off (`details.from/to`).
  'org.sso.required.update',
  // An IdP metadata document was imported into the SAML form (parsed, not
  // saved — the save is a separate `admin.org-idp.upsert`). `details.source` is
  // `url` (with the host fetched) or `xml`.
  'org.idp.metadata.import',
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
  // Plugin image signed + SBOM-attested with the platform plugin-signing key.
  'registry.image.sign',
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
  // Log-surface data egress. `observability.logs.export` records a download of
  // log content (range, filter, format, line count, truncation) — cheap request,
  // large egress, and it leaves the building, so it is audited like
  // `admin.org.export`. `observability.logs.cross-org-read` records a system
  // admin reading a tenant OTHER than `_infra`, the same accountability the
  // impersonation work applies to viewing another org's data.
  'observability.logs.export',
  'observability.logs.cross-org-read',
  // Platform admin mutations that were previously unaudited (controllers).
  // `admin.org.ai-config.update` — org AI-provider config (holds provider API
  //   keys; details carry field NAMES only, never a key value).
  // `admin.user.features.update` — a sysadmin editing a user's feature overrides.
  'admin.org.ai-config.update',
  'admin.user.features.update',
  // "Ask" assistant (api/ask) — safe metadata only (tools used, proposal kinds,
  // query length, outcome), never the raw query text. `ask.query` = read-only
  // how-to turn; `ask.agent.turn` = tool-calling turn.
  'ask.query',
  'ask.agent.turn',
  // Plugin ecosystem (docs/plans/plugin-ecosystem.md §5c). Governance actions
  // are recorded with `orgId` = the system org; `affectedOrgId` is the
  // publisher's org (listing/version/review/advisory/publisher moderation) or
  // the installing org (installs + policy). Anonymous submissions use the
  // `ANONYMOUS_ACTOR_ID` actor with `details.submissionId`. `details` carry ids,
  // versions, digests, tier, state and reason codes only — never review bodies,
  // README content, secrets or emails.
  // Publishers.
  'publisher.create',
  'publisher.update',
  'publisher.terms.accept',
  'publisher.verify.request',
  'publisher.verify.approve',
  'publisher.verify.reject',
  'publisher.tier.change',
  'publisher.suspend',
  'publisher.unsuspend',
  'publisher.transfer.request',
  'publisher.transfer.accept',
  'publisher.transfer.decline',
  'publisher.transfer.approve',
  'publisher.transfer.reject',
  'publisher.profile-change.approve',
  'publisher.profile-change.reject',
  // Publish requests (tenant → system org). `details.kind` names the request.
  'plugin.request.submit',
  'plugin.request.withdraw',
  'plugin.request.approve',
  'plugin.request.second-approve',
  'plugin.request.reject',
  'plugin.request.auto-approve',
  // Listings and versions (system org, except the tenant pause).
  'plugin.listing.publish',
  'plugin.listing.unlist',
  'plugin.listing.update',
  'plugin.listing.state.change',
  'plugin.listing.pause',
  'plugin.listing.unpause',
  'plugin.version.pause',
  'plugin.version.yank',
  'plugin.version.unyank',
  'plugin.version.deprecate',
  'plugin.collection.update',
  // Ecosystem configuration (system org).
  'ecosystem.auto-approval-rule.create',
  'ecosystem.auto-approval-rule.update',
  'ecosystem.auto-approval-rule.delete',
  'ecosystem.reserved-name.update',
  'ecosystem.sla.update',
  // Public registry namespace (`public/*`): copy + sign + attest on publish,
  // the tier-change/suspension re-sign job, tag removal on yank/takedown, and
  // the retention sweep.
  'registry.image.publish',
  'registry.image.resign',
  'registry.image.yank',
  'registry.image.gc',
  // Installs and the installing org's consumption policy (org-local).
  'plugin.install.request',
  'plugin.install.approve',
  'plugin.install.deny',
  'plugin.install.create',
  'plugin.install.upgrade',
  // A member's request to change an install past what they may do alone, and its decision.
  'plugin.install.change-request',
  'plugin.install.change-approve',
  'plugin.install.change-reject',
  'plugin.install.remove',
  'org.plugin-install-policy.update',
  // Reviews and replies.
  'plugin.review.create',
  'plugin.review.update',
  'plugin.review.delete',
  'plugin.review.report',
  'plugin.review.hold',
  'plugin.review.release',
  'plugin.review.remove',
  'plugin.review.anonymize',
  'plugin.review.reply.create',
  'plugin.review.reply.update',
  'plugin.review.reply.delete',
  // Anonymous submissions.
  'plugin.submission.create',
  'plugin.submission.verify',
  'plugin.submission.gate-fail',
  'plugin.submission.approve',
  'plugin.submission.reject',
  'plugin.submission.claim',
  'plugin.submission.expire',
  // Security advisories (publish/withdraw are system-org only; update = a
  // moderator editing a draft before it is published).
  'plugin.advisory.create',
  'plugin.advisory.update',
  'plugin.advisory.publish',
  'plugin.advisory.withdraw',
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
   *  `details` so reviewers can filter "who touched role X". */
  roleId?: string;
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
  /** TAMPER-EVIDENCE: HMAC-SHA256 (key = `AUDIT_CHAIN_HMAC_KEY`, held outside
   *  the DB) of this event's immutable fields plus `seq` and `prevHash` (see
   *  `helpers/audit-chain.ts`). Lets a verifier detect any post-hoc mutation of
   *  a stored row — and, because the key isn't in the DB, a DB writer can't
   *  re-chain around an edit. */
  hash?: string;
  /** TAMPER-EVIDENCE: 1-based position in the per-tenant chain. Assigned from
   *  the chain head under a UNIQUE `(affectedOrgId, seq)` index, so the chain
   *  is ordered by sequence, never by wall-clock `createdAt`; a missing number
   *  is a deleted row. */
  seq?: number;
  /** TAMPER-EVIDENCE: the `hash` of the most recent PRIOR event in the same
   *  per-tenant chain (chain key = `affectedOrgId ?? orgId`), or `null` for the
   *  first event in a chain. A missing/re-pointed link reveals a deleted or
   *  reordered row. */
  prevHash?: string | null;
  /** DEDUP: the stable `Idempotency-Key` the remote-audit client stamps on each
   *  emission (and reuses across its 5xx/timeout retries); platform-local
   *  `audit()` stamps one too so a spooled retry dedups. UNIQUE PER ORG
   *  (`orgId`, `idempotencyKey`) so a re-delivered event collides at the DB —
   *  even across replicas — while one tenant can never pre-claim (and so
   *  suppress, or read back) another tenant's key. */
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
  // Sparse: only role/impersonation/correlation events set these, so the
  // index skips the (vast majority of) documents that leave them unset.
  roleId: { type: String, index: { sparse: true } },
  impersonatorId: { type: String, index: { sparse: true } },
  outcome: { type: String, enum: ['success', 'failure'] },
  details: { type: Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  requestId: { type: String, index: { sparse: true } },
  traceId: { type: String },
  // TAMPER-EVIDENCE hash chain (see helpers/audit-chain.ts). `hash` is
  // deliberately NOT `required`: a digest failure still writes the row (with a
  // sentinel) rather than rejecting it. The tail pointer lives in the
  // `audit_chain_heads` collection; `(affectedOrgId, seq)` below orders the chain.
  hash: { type: String },
  seq: { type: Number },
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

// DEDUP backstop — UNIQUE per org on the ingest idempotency key. Partial (not
// sparse: a sparse COMPOUND index still indexes every row that has `orgId`) so
// only events that carry a key are constrained; scoped by `orgId` (the emitting
// tenant) so a key can only collide with that same tenant's own emissions.
auditEventSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
);

// CHAIN SEQUENCE — UNIQUE on (affectedOrgId, seq). The append path takes
// `seq = head.seq + 1`; two replicas racing for the same slot collide here
// (E11000) and the loser re-reads the advanced head and retries, so the chain
// can never fork. Also the verify walk's ordering index (ascending seq).
auditEventSchema.index({ affectedOrgId: 1, seq: 1 }, { unique: true });

// TTL index — auto-delete events after `config.audit.retentionDays` days
// (default 90, overridable via AUDIT_RETENTION_DAYS at boot). Reading from
// `config` keeps the env-parse in one place.
auditEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: config.audit.retentionDays * 86400 },
);

export default model<AuditEventDocument>('AuditEvent', auditEventSchema);
