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
  // Fixable Critical findings were EXEMPTED from the platform floor by a
  // `PLUGIN_VULN_WAIVERS` entry, so a build that would otherwise have failed
  // PLUGIN_VULN_GATE was allowed through. The other half of plugin.scan.skipped:
  // both are operator escape hatches that change a gate's verdict, and a metric
  // and a log line are not a durable record of one. `details` carry
  // name/version/digest, how many findings were waived and which packages.
  'plugin.vuln.waived',
  // The nightly rescan FLAGGED a stored version (its gated Critical findings
  // now exceed PLUGIN_VULN_MAX_CRITICAL — lookup and the pipeline's owners are
  // warned at `error` severity), or CLEARED that flag. Both change what
  // resolution says about a version nobody rebuilt, on nobody's request, so the
  // record of WHEN and WHY lives in the hash-chained log rather than only in a
  // column the next rescan overwrites. `details` carry counts, the gated
  // advisory ids and the image digest.
  'plugin.vuln.flagged',
  'plugin.vuln.cleared',
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
  // An account's quota threshold-notice settings (opt-out + the
  // `quota.threshold` webhook URL) — where usage warnings go.
  'quota.notice_settings.update',
  // Compliance administration (api/compliance) — the enforcement-posture surface.
  // Approving/revoking an exemption, toggling/authoring/deleting a rule,
  // authoring/deleting a policy, managing scan schedules, applying a template,
  // or cancelling a running scan. `targetId` is the rule/policy/exemption/scan id.
  'compliance.exemption.approve',
  'compliance.exemption.revoke',
  // A member FILING an exemption request (single or bulk; metadata only, never
  // the reason) and an admin REJECTING one — the other halves of the
  // two-person decision whose approval is recorded above.
  'compliance.exemption.request',
  'compliance.exemption.reject',
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
  // A scan's terminal OUTCOME (completed → success with the pass/warn/block
  // counts, failed → failure). Scheduled scans also write `compliance.scan.create`
  // (`details.triggeredBy: 'scheduled'`), attributed to the schedule's author.
  'compliance.scan.complete',
  // Platform onboarding subscribing a new org to every published rule
  // (INACTIVE subscriptions; `details.subscribed` is the count).
  'compliance.subscription.auto-subscribe',
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
  // The Docker token endpoint minting a registry token that GRANTS access
  // (`details.granted`: repo + actions; the scope-less `docker login` probe is
  // not recorded) — and, as outcome failure, a refused credential (hashed
  // username, credential kind only).
  'registry.token.issue',
  // A push credential minted for one anonymous submission's
  // `quarantine/<submissionId>` repo (expiry + TTL, never the secret).
  'registry.quarantine.credential.mint',
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
  // An author's edit of a sent message (and refused attempts, as failures).
  // `details` carry the new body's LENGTH only — neither side of the edit.
  'message.update',
  // A message attachment stored (general or support mount, `details.surface`).
  // Type + size only — never the bytes, and not the user-chosen filename.
  'message.attachment.upload',
  // A SYSTEM notification dropped into an org's inbox by an internal service
  // (POST /messages/internal/notify); `details.caller` names the service.
  'message.notify.internal',
  // The platform org-delete cascade reclaiming an org's attachment BLOBS —
  // `details.blobsDeleted`, or a failure row when the reclaim did not complete.
  'message.org.purge',
  // Support cases (api/message). Distinct from the `message.*` family above
  // because a case is not an ordinary message: it carries a response-time
  // commitment, so WHO raised it and WHEN we first answered are the facts a
  // dispute turns on. `details` carry the case number, level and severity —
  // metadata only, never the body of what a customer wrote.
  //
  // Two of the nine planned support actions are here, and only two: these are
  // the ones with real emitters today. The rest (`status`, `severity`,
  // `assign`, `transfer`, `note`, `read`) land WITH the routes that emit them —
  // a declared action nothing emits is dead vocabulary, and the parity test
  // would then force a docs row describing an event that never fires.
  //
  // `support.case.read` will matter most of all when it arrives: it is the only
  // record that someone at the vendor opened a customer's case.
  'support.case.open',
  'support.case.reply',
  // The workflow mutations. Each is audited because each moves a case's
  // relationship to its response commitment: status stops or restarts the
  // clock, severity changes which target applies, and the two ownership
  // actions decide WHO is accountable for meeting it. A silent change of owner
  // is how accountability for a missed target disappears.
  'support.case.status',
  'support.case.severity',
  'support.case.assign',
  'support.case.transfer',
  // ON-CALL. The provider owns the rota, the escalation and the contact
  // methods; what it cannot own is an auditable answer to "who picked this up
  // at 03:14". A click on a link in their UI is not an identity this system can
  // attest to, so their incident state change is relayed here and recorded
  // against the agent they name. The hash chain is the point: a post-incident
  // review needs the ack to be evidence rather than a screenshot.
  //
  // `escalated` is audited separately because it is the record that the FIRST
  // responder did not answer — the fact a rota is adjusted on, and the one most
  // likely to be disputed later.
  'support.oncall.acknowledged',
  'support.oncall.escalated',
  // The test page. Audited because it RINGS A PHONE: whoever it wakes is
  // entitled to a record of who caused that, at whatever hour it was.
  'support.oncall.test',
  // The per-case sweep paging the rota for a premium case nearing its target.
  // Recorded once, on the tick the case ENTERED the window — the sweep re-sends
  // the page every tick, and twenty-four rows for one page would be noise.
  'support.oncall.paged',
  // The two CONTACT actions (platform). Not case events — entitlement events:
  // each one changes who in an org is able to commit us to a response target at
  // all, and designating spends a slot of a PAID, account-pooled allowance. The
  // revoke carries the count of open cases it left behind, so an orphaned case
  // is a recorded fact rather than something discovered later.
  'support.contact.designate',
  'support.contact.revoke',
  // The premium UPGRADE, both directions. Separate actions from designation
  // because they answer to a different cap and carry a different fact: who was
  // entitled to 24x7 coverage, and when. A response-time dispute over an
  // out-of-hours case turns on exactly that.
  'support.contact.upgrade',
  'support.contact.downgrade',
  // Staff notes on a case. Audited because a note is the vendor's internal
  // assessment of a customer and the only surface on a case the tenant must
  // never see; the trail carries METADATA ONLY (case number, note id, length)
  // and never the body, since the central trail is read far more widely than
  // the support queue is.
  'support.case.note',
  // The canned-reply library. ONE action for create/edit/retire rather than
  // three, because the trail's question here is "who changed the wording the
  // desk sends customers", not which verb they used — `details` carries that.
  // System-wide rather than per-tenant, so these rows name no affected org.
  'support.canned.write',
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
  // A NEGOTIATED support size floor replacing the computed ramp. System-org
  // only, and audited with the agreed PRICE and the agreed SEAT COUNT together:
  // a dispute about what was signed for turns on that pair, and the price alone
  // cannot answer "at what scale".
  'billing.support-floor.override',
  // A GRANTED one-time support incident — a commercial concession, not a sale.
  // There is deliberately no purchase path: monthly support cancels freely, so
  // an incident priced above a month is dominated and one below it loses money.
  // The row carries the count and the resulting balance, which is what a later
  // review of "who gave what away" needs.
  'billing.support-incident.grant',
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
  // Stakeholder reports — the add-on's authoring and PUBLISHING surface. Publishing
  // is the moment internal delivery numbers leave the platform, so the whole
  // outward path is auditable: which report, which period's frozen snapshot,
  // which version, and who let it out. `link.created` / `link.revoked` cover the
  // URLs that let someone without an account read it; `recipient.added` /
  // `recipient.removed` cover who is on the distribution list, which is the other
  // way data reaches a person. `ownership.transfer` is a privilege move: a
  // scheduled run is authorized as its OWNER, so handing a definition over hands
  // over whose access the numbers are computed with.
  //
  // Deliberately NOT audited: reading a shared report. The access is logged and
  // counted per link, but it is an UNAUTHENTICATED, externally-triggered event —
  // anyone holding a URL could otherwise write unbounded rows into the org's audit
  // trail, which turns a read into a way to bury the entries that matter.
  'reporting.report.definition.create',
  'reporting.report.definition.update',
  'reporting.report.definition.delete',
  'reporting.report.ownership.transfer',
  'reporting.report.published',
  'reporting.report.republished',
  'reporting.report.link.created',
  'reporting.report.link.revoked',
  'reporting.report.recipient.added',
  'reporting.report.recipient.removed',
  'reporting.report.policy.update',
  // A definition STOPPED producing reports without anyone asking it to: the owner
  // was deactivated or removed, or lost the permission a run is authorized with.
  // Recorded because the effect is silent — a manager finds out by not receiving
  // the report — so the trail has to say which reports stopped and why.
  'reporting.report.paused',
  // …and started again. Its own action rather than a detail on the pause, because the
  // question a reviewer asks is "was this account's reporting off between these two
  // dates", and answering it from a single action's details means reading every row.
  'reporting.report.resumed',
  // The drafting half of a run: a compose/regenerate freezes the org's numbers
  // into a run, the lead's notes are edited onto it (metadata only — length,
  // never the prose), and an AI summary is drafted from it (the numbers went to
  // a provider; `outcome` carries a refusal). A resend re-mints a recipient's
  // confirmation credential. `verified` / `unsubscribed` are the UNAUTHENTICATED
  // recipient's own acts (actor `anonymous`, a hashed address only): bounded by
  // construction — the verify token is single-use, and only the click that
  // actually stops delivery writes an unsubscribe row.
  'reporting.report.run.compose',
  'reporting.report.run.notes',
  'reporting.report.run.summary',
  'reporting.report.recipient.resend',
  'reporting.report.recipient.verified',
  'reporting.report.recipient.unsubscribed',
  // MACHINE ingest (`reporting:ingest` scope). One `batch` row per POST to the
  // event / incident / ingest-health routes — counts plus capped pipeline,
  // execution, EventBridge-event and incident id lists, attributed to the
  // credential's principal — so a forged or misrouted write names the key behind
  // it. `rejected` is the tenancy refusal inside a batch (events naming another
  // org's pipelines): a FAILURE row with the offending pipeline ids, never the
  // org they belong to. `incident.record` is one incident that is new or actually
  // changed (before/after); like `deployment.outcome` it moves CFR/MTTR. An
  // unchanged repeat-interval re-post writes none.
  'reporting.ingest.batch',
  'reporting.ingest.rejected',
  'reporting.incident.record',
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
  // A reader rating an answer, or a help search that found nothing. The ONLY
  // signal for which docs the assistant answers badly from — the turn itself
  // cannot tell a good answer from a confident wrong one. `details` carry the
  // rating and the DOC IDS cited (`authentication.md`), never the question: the
  // doc is what gets fixed, and it is not user-entered text.
  'ask.feedback',
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
  // NOTE: there is no `plugin.listing.unlist`. Withdrawal is already expressed by
  // `plugin.listing.state.change` (`unmaintained` / `suspended` / `listed`),
  // which is the action the code actually emits, so `unlist` was a second name
  // for a thing that has one — and a never-emitted one at that.
  'plugin.listing.update',
  'plugin.listing.state.change',
  'plugin.listing.pause',
  'plugin.listing.unpause',
  'plugin.version.pause',
  'plugin.version.yank',
  'plugin.version.unyank',
  'plugin.version.deprecate',
  // NOTE: no `plugin.collection.update`. `ecosystem_collections` was deleted (see
  // the tombstone in `schema/ecosystem.ts`) because nothing ever wrote or read
  // one; this declaration outlived the table it audited.
  // Ecosystem configuration (system org).
  'ecosystem.auto-approval-rule.create',
  'ecosystem.auto-approval-rule.update',
  'ecosystem.auto-approval-rule.delete',
  'ecosystem.reserved-name.update',
  // The one-time BOOTSTRAP exception (auto-approval of the initial Official
  // catalog) opening on the first Official request, and closing for good
  // (`details.reason`: window_elapsed / listings_exist / a manager decision;
  // `details.approved`: how many requests rode it).
  'ecosystem.bootstrap.open',
  'ecosystem.bootstrap.close',
  // NOTE: no `ecosystem.sla.update`. The lane SLAs are HARDCODED (standard 48h,
  // security-fix 4h in `services/ecosystem/sla.ts`) with no settings surface, so
  // there is no mutation to audit. Making them operator-tunable is the change
  // that should re-add this.
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
  // An upload REFUSED because its name would override something the org already
  // resolves — a listing, or a team's parent-org plugin — and the consumption
  // policy says `shadowing: deny`. Audited because a refusal otherwise returns
  // an error to the caller and leaves nothing behind: an attempt to define
  // `trivy` over the Official scanner is exactly the thing someone should be
  // able to find afterwards. `details` carry the name and what it would have
  // overridden.
  'plugin.shadowing.denied',
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
  // A gate-refused image KEPT from the setup catalog load, promoted to a
  // version without a rebuild (system org, after a fix upstream or an
  // advisory-id waiver) — or refused again because the CURRENT gates still
  // fail it. `details` carry name/version/digest and the findings.
  'plugin.setup_image.promoted',
  'plugin.setup_image.promote_refused',
  // A gate-refused setup-load image KEPT (signed, in the registry) for later
  // promotion (`details`: digest, refusal code, expiresAt) — and its row
  // dropped by the sweep (`details.reason`: expired / superseded).
  'plugin.setup_image.kept',
  'plugin.setup_image.discarded',
  // A PIPELINE's triage of its exposure to a vulnerable plugin version: a
  // time-boxed risk acceptance (reason + expiry, the accepted finding keys and
  // whether KEV findings were accepted), a false-positive dismissal, or a
  // reopen. An active acceptance exempts that pipeline's lookups and runtime
  // checks from the flag / KEV / High-floor refusals for those findings only.
  'pipeline.vuln.accepted',
  'pipeline.vuln.false_positive',
  'pipeline.vuln.reopened',
  // A pipeline's runtime check graded one of its running images `error` or
  // louder (`details`: stepKey, digest, reason codes, executionId when sent).
  'pipeline.runtime_check.flagged',
  // A pipeline's plugin steps moved to newer versions through the upgrade
  // flow (preview → apply; `details` carry the steps, from → to versions), and a
  // pipeline-run security scanner report uploaded for a pipeline (`details`:
  // tool, format, stage, the finding counts — never the findings themselves).
  'pipeline.plugin.upgraded',
  'pipeline.security_report.upload',
] as const;

export type RemoteAuditAction = typeof REMOTE_AUDIT_ACTIONS[number];

/** Whether `value` is an action a remote service may emit (the ingest allow-list). */
export function isRemoteAuditAction(value: string): value is RemoteAuditAction {
  return (REMOTE_AUDIT_ACTIONS as readonly string[]).includes(value);
}
