// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remote (non-platform) audit ACTION VOCABULARY.
 *
 * Kept apart from the client that ships the events (`services/remote-audit-client.ts`)
 * because it is an allow-list, not machinery: it is the thing a reviewer reads
 * end to end when deciding whether a service may emit a given action, and it is
 * what platform's ingest validates against.
 */


/**
 * The exact set of audit actions a NON-PLATFORM (remote) service is permitted to
 * emit through `POST /audit/events`. This is the SINGLE SOURCE — `RemoteAuditAction`
 * is derived from it, so the type and the runtime allow-list can never drift.
 *
 * SECURITY: platform's ingest validates `action` against this subset (via
 * {@link isRemoteAuditAction}), NOT the full platform `AuditAction` union — a
 * `service:*` token must not be able to forge platform-authority events
 * (`admin.superadmin.grant`, `org.ownership.transfer`, `user.login`, …). Keep
 * this list free of any platform-only action.
 */
export const REMOTE_AUDIT_ACTIONS = [
  'plugin.build.completed',
  'plugin.build.failed',
  'plugin.build.timeout',
  // A version persisted UNSCANNED because the build-time scan could not run and
  // the operator escape hatch `PLUGIN_ALLOW_UNSCANNED` is on (without it the
  // build fails `IMAGE_SCAN_UNAVAILABLE`). `details` carry name/version/digest.
  'plugin.scan.skipped',
  // Plugin lifecycle mutations (api/plugin route handlers) — the destructive /
  // publishing surface that builds already audit's counterpart: registry delete,
  // source upload, and deploy-to-cluster. `targetId` is the plugin id.
  'plugin.delete',
  'plugin.restore',
  // Manual purge: permanent hard-delete of a soft-deleted plugin tombstone on
  // demand (finalizes what the retention sweep would otherwise do later).
  'plugin.purge',
  'plugin.update',
  'plugin.upload',
  'plugin.deploy',
  // Plugin bulk mutations (api/plugin bulk-plugin route) + DLQ purge (drops all
  // dead-lettered build jobs, cross-org, sysadmin). `details` carries counts.
  'plugin.bulk.update',
  'plugin.bulk.delete',
  'plugin.dlq.purge',
  // Build re-runs from the queue-triage surface: re-enqueue a FAILED build
  // (`plugin.build.retry`) or a dead-lettered one (`plugin.dlq.replay`). Both
  // re-run an image build + plugin persist on the caller's authority, so they
  // are audited mutations; `affectedOrgId` carries the job's owning org.
  'plugin.build.retry',
  'plugin.dlq.replay',
  // Pipeline mutations — emitted by api/pipeline's route handlers
  // (create/update/delete + CodePipeline execution trigger/cancel) and
  // posted to platform's `POST /audit/events` ingest.
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.restore',
  // Manual purge: permanent hard-delete of a soft-deleted pipeline /
  // pipeline_template tombstone on demand (finalizes what the retention sweep
  // would otherwise do later). `targetId` is the purged id.
  'pipeline.purge',
  'pipeline_template.create',
  'pipeline_template.update',
  'pipeline_template.delete',
  'pipeline_template.restore',
  'pipeline_template.purge',
  'pipeline.execution.start',
  'pipeline.execution.cancel',
  // CodePipeline ARN-registry config (api/pipeline registry route) — registering /
  // deregistering the external CodePipeline that backs a pipeline (deploy-affecting).
  'pipeline.registry.register',
  'pipeline.registry.deregister',
  // Quota administration (api/quota) — a superadmin resetting an org's usage
  // counter or editing its tier limits. `affectedOrgId` is the org changed;
  // `details` carries the quotaType + old/new value.
  'quota.reset',
  'quota.limit.update',
  // A superadmin deleting an org's entire quota document.
  'quota.delete',
  // Compliance administration (api/compliance) — the enforcement-posture surface.
  // Approving/revoking an exemption, toggling/authoring/deleting a rule,
  // authoring/deleting a policy, managing scan schedules, applying a template,
  // or cancelling a running scan. `targetId` is the rule/policy/exemption/scan id.
  'compliance.exemption.approve',
  'compliance.exemption.revoke',
  'compliance.rule.toggle',
  'compliance.rule.create',
  'compliance.rule.update',
  'compliance.rule.delete',
  'compliance.rule.restore',
  // Manual on-demand hard-delete (PURGE) of a soft-deleted rule/policy tombstone —
  // the caller-initiated counterpart to the retention sweep's auto-purge. Destroys
  // the tombstone permanently, so it carries the durable, tamper-evident trail.
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
  // Launching an org-wide re-evaluation (the counterpart to `.cancel`) — it
  // persists a scan and can block entities that passed before.
  'compliance.scan.create',
  'compliance.scan.cancel',
  // Per-org compliance notification settings: recipients + the outbound webhook
  // URL/secret. Bearer-equivalent config that redirects violation notices, so a
  // change carries the durable trail (never the secret itself).
  'compliance.notification-preference.update',
  // Image-registry destructive ops (api/image-registry) — garbage-collection
  // sweeps and explicit image/tag deletes.
  'registry.gc',
  'registry.image.delete',
  // Cross-repo tag/image copy (api/image-registry POST /api/images/copy). A
  // cross-tenant copy moves data across customer boundaries, so it needs the
  // durable, tamper-evident trail — not just the Loki operator line.
  'registry.image.copy',
  // A plugin image signed + SBOM-attested by the platform's plugin-signing key
  // (api/image-registry POST /internal/plugin-signatures, called by the plugin
  // build worker). The key is what synth trusts, so every use is on the trail.
  'registry.image.sign',
  // Messaging (api/message) — admin BROADCAST announcements + destructive
  // deletes. 1:1 user messages are intentionally NOT audited (noise + they would
  // pull private content into the trail). `details` carry metadata only
  // (subject/type/scope), NEVER message body content.
  'message.announcement.create',
  'message.delete',
  'message.restore',
  // Manual on-demand PURGE (permanent hard-delete) of an already-soft-deleted
  // message tombstone — the destructive finalizer the retention sweep would
  // otherwise perform at the purge deadline. `details` carry metadata only.
  'message.purge',
  // Billing (api/billing) — subscription + entitlement mutations, mirrored to the
  // central audit trail (these also write to the service-local billing_events
  // collection). `details` carry plan/tier/addon ids only — never card/payment
  // secrets or an AWS account id.
  // Subscription lifecycle a CUSTOMER drives (the admin counterpart is
  // `billing.tier.override`): self-serve create (direct or Marketplace claim),
  // plan/interval change, cancel-at-period-end, undo-cancel, cascade delete.
  'billing.subscription.create',
  'billing.subscription.update',
  'billing.subscription.reactivate',
  'billing.subscription.cancel',
  'billing.subscription.delete',
  'billing.tier.override',
  // Operator-only reseed of the invoice ledger from the payment provider's
  // history (POST /billing/admin/backfill) — mutates finance data fleet-wide.
  'billing.addon.add',
  'billing.addon.remove',
  // System-initiated removal of a tier-included add-on on a plan upgrade (the
  // account's new tier now bundles the feature) — distinct from a user-initiated
  // `remove` so finance can tell an auto-prune from a customer action.
  'billing.addon.prune',
  // Discounts (docs/billing-discounts.md) — mint/issue/apply/remove/revoke of a
  // price coupon or usage credit. `details` carry the discount id + kind/value
  // only, never the opaque token or signing key.
  'billing.discount.generate',
  'billing.discount.issue',
  'billing.discount.apply',
  'billing.discount.remove',
  'billing.discount.revoke',
  // Promotions (docs/billing-discounts.md#promotions) — rule-driven auto-grant
  // campaigns. `details` carry the promotion id + cents/event only.
  'billing.promotion.create',
  'billing.promotion.update',
  'billing.promotion.revoke',
  'billing.promotion.grant',
  'billing.promotion.activate',
  // Usage-credit realization — a customer/compliance-visible record of credit
  // movement: `consumed` (Marketplace metered drawdown), `exhausted` (balance hit
  // zero), and a combo ending. `details` carry cents/ids only, no payment secrets.
  'billing.credit.consumed',
  'billing.credit.exhausted',
  'billing.combo.expired',
  // Reporting (api/reporting) — the three reporting mutations whose effect
  // outlives a request log: the per-org correlation-window config write, a
  // post-deploy outcome marker (it moves the org's DORA CFR/MTTR), and the
  // inbound billing→reporting retention-entitlement sync (a retention cut is a
  // data-destroying change applied by the next sweep). `details` carry the
  // settings/outcome values only.
  'reporting.settings.update',
  'reporting.deployment.outcome',
  'reporting.retention.sync',
  // Denied authorization attempt — emitted best-effort by the shared
  // `requirePermission` / `requireSystemAdmin` gate when a state-changing
  // (non-GET) request is rejected, so probing/escalation attempts are visible
  // rather than invisible. `details` carries the required permission + path;
  // `outcome` is 'failure'.
  'authz.denied',
  // "Ask" assistant activity — visibility into what the assistant did on a user's
  // behalf. `ask.query` is a read-only how-to turn; `ask.agent.turn` is a tool-calling
  // turn. `details` carry SAFE METADATA ONLY (tools used, proposal kinds, query
  // length, outcome), never the raw query text.
  'ask.query',
  'ask.agent.turn',
  // Plugin ecosystem (docs/runbooks/ecosystem-moderation.md). Governance actions
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
  // Per-org plugin security notifications (plugin scan gates): the settings
  // (recipients, digest, webhook, external address — changed field names and
  // the webhook host only, never the secret or the address), an external
  // address confirmed through its emailed single-use link, and a test send.
  'plugin.security_notifications.update',
  'plugin.security_notifications.external_email.verify',
  'plugin.security_notifications.test',
] as const;

export type RemoteAuditAction = typeof REMOTE_AUDIT_ACTIONS[number];

/** Whether `value` is an action a remote service may emit (the ingest allow-list). */
export function isRemoteAuditAction(value: string): value is RemoteAuditAction {
  return (REMOTE_AUDIT_ACTIONS as readonly string[]).includes(value);
}
