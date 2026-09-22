---
layout: default
title: Ecosystem Moderation
---

# Ecosystem Moderation Runbook

For **Ecosystem Managers** and superadmins: the people in the system
organization who decide everything that enters or changes the plugin
ecosystem. This is a staff runbook, linked from the Ecosystem console; it is not
part of in-app help. Publisher-facing behaviour, and the reasoning behind the
governance model, is in [Plugin Publishing](../plugin-publishing.md#why-the-ecosystem-works-this-way).

## Before you start

- **Where.** Dashboard → Admin → **Ecosystem**, with the **system organization**
  as your active org. Every console route refuses a token from any other org
  (`403 SYSTEM_ORG_REQUIRED`), even for the same person.
- **Session.** An MFA-grade sign-in (aal2) is required. Suspensions, yanks,
  rule changes, re-signs and every `publishers:verify` decision also ask you to
  re-authenticate (step-up).
- **Role.** The built-in **Ecosystem Manager** role grants `plugins:moderate`
  and `publishers:verify`. Only a superadmin can assign it. Keep **at least
  three** holders so two-person approval and holiday cover always work. The
  queue overview shows the headcount platform reports (holders of
  `plugins:moderate` in the system org) and warns below three, and more
  strongly below two, when a superadmin has to be every second approver. Each
  open request also says how many managers can still decide **it**, after its
  conflicts of interest (members of the requesting, publishing and receiving
  orgs, the submitter, and the first approver) are taken out.

## Queues and SLAs

| Lane | Contents | Target |
|------|----------|--------|
| Standard | New listings, new versions, listing updates, unpauses, publisher-level requests | 2 business days (48 h) |
| Security | A version or yank linked to an advisory on the listing | 4 hours; managers are told at once (N24) |
| Second approval | Requests with one approval, waiting for a different manager | same as the lane |

The queue opens oldest first. A row past its SLA is marked. Filters: open,
awaiting second approval, auto-approved, decided; by kind and lane.

### Alerts and SLA breaches

When a request passes its lane's SLA, every Ecosystem Manager holding the
permission that decides it gets one **N22** email (transactional, no opt-out),
security-fix requests listed first. Each request is announced **once**: the
maintenance scheduler (every 15 minutes, leader-locked) remembers what it has
announced and forgets a request once it leaves the queue. A notice that can't
be queued is retried on the next pass.

The paging half is Prometheus (all targets; the list is in
[Deploy Operations](../deploy-operations.md#operator-consoles-grafana-kiali)):

| Alert | What to do |
|-------|-----------|
| `EcosystemSecurityLaneSLABreach` (critical) | Decide the security-lane request now. If nobody eligible is available (conflicts, two-person), a superadmin can be the second approver. |
| `EcosystemStandardLaneSLABreach` | Work the queue oldest first; check the headcount if two-person requests are piling up in *awaiting second approval*. |
| `EcosystemResignFailures` / `EcosystemResignStalled` | See [Re-sign job](#re-sign-job): check image-registry health and the plugin service's `ecosystem-resign` logs. The job resumes by itself once the cause is fixed. |
| `EcosystemApproverShortage` | A superadmin adds managers on the **Ecosystem Managers** tab. |
| `EcosystemNotificationsDropped` | Check platform's `/internal/notify-email` relay and SMTP. The in-app copy is usually still delivered. |
| `SubmissionBacklogHigh` | Many anonymous submissions waiting. See [Anonymous submissions](#anonymous-submissions). |
| `SubmissionGateFailureSpike` | One gate failing often: abuse (heuristics / secrets) or a broken gate (vuln scan, smoke test). See [Anonymous submissions](#anonymous-submissions). |
| `PluginLookupRefusalSpike` | Synth lookups refused because a plugin image's signature (or its signed tier annotation) no longer verifies. Check `plugin_lookup_refusals_total{reason}` by listing in the plugin logs ("Plugin image failed verification"); a re-pushed or tampered `public/*` image needs a yank, a stale tier annotation a re-sign (Ecosystem console → Re-sign). |
| `OfficialAutoApprovalAnomaly` | The Official catalog rule is near its daily cap or far above its usual rate. Check recent `plugin.request.auto-approve` events; `OFFICIAL_AUTO_APPROVAL_ENABLED=false` stops the rule at once. |

The **Plugin ecosystem** Grafana dashboard (`/grafana/`, folder *Pipeline
Builder*) shows queue depth by kind and status, oldest pending request per
lane, decisions and their latency, auto-approvals per rule (a sudden jump in
one rule is the "auto-approval rate anomaly"), refusals, headcount, re-sign
progress and notice sends.

## Deciding a request

1. Open the request. The **review** shows it against the previous approved
   version:
   - **Metadata**, per field, with where it came from (Spec, README, Dockerfile,
     Generated, Edited). A **highlighted link** was typed by the publisher
     rather than detected from the package: check where it goes, because an
     edited link is how a phishing change looks.
   - **Contract changes**: new or removed secrets, egress hosts, required
     inputs, environment keys, changed commands, and a move to running as
     root. Any of these widens what the plugin can do in a customer's
     CodeBuild project.
   - **Vulnerabilities**: new critical and high findings compared with the
     previous version.
   - **Dockerfile** and **SBOM** package changes.
   - **Icon**: flagged when a Community publisher uses a curated vendor mark.
   - **Publisher history**: tier, age, approved and rejected requests.
   - **Auto-approval**: why each rule would or wouldn't approve it.
2. **Approve**, **Reject** (a reason is required and is sent to the
   publisher) or leave it for someone else.

### Verified applications

Eligibility is checked **automatically**, when the publisher applies and again
when you decide (both the first approval and the second, executing one), and
also when you start a *Make Verified* from the Publisher verification tab:

- **Plan**: the organization's plan includes Verified publishing (Team,
  Enterprise, or a self-hosted instance);
- **Verified domain**: its root organization has a DNS-verified domain
  (platform's domain verification); a domain named in the application must be
  one of them;
- **Owner MFA**: every active owner has a passkey or an authenticator app.

An application that fails a check is refused with `VERIFIED_PLAN_REQUIRED`,
`VERIFIED_DOMAIN_REQUIRED` or `VERIFIED_OWNER_MFA_REQUIRED`; if platform can't
answer, with a 503, and nothing is queued. The Publisher verification tab shows
each application's checks as they were at submission, and the review shows a
live re-check. An approval that fails the re-check leaves the request where it
was: reject it with the reason, or wait for the publisher to fix it. What the
checks can't judge (is this really the vendor? is the publisher's history
clean?) is still yours to review.

### Separation of duties

You can't decide a request:

- that you submitted;
- from an organization you belong to (checked against platform membership at
  decision time; if membership can't be checked, the answer is no);
- for an Official version that you uploaded;
- a second time: the second approval of a two-person decision must come from a
  different person, and that includes a superadmin approving twice.

A refused decision answers `403 SEPARATION_OF_DUTIES`.

### Two-person approval

These need two different managers (or a manager and a superadmin):

- every Official request that no auto-approval rule covered (new listings,
  majors, risky updates, link or icon changes);
- Verified applications and changing a publisher's tier to Verified;
- unyanking a version;
- lifting a publisher suspension or relisting a suspended listing;
- creating, enabling or widening an auto-approval rule.

The first approval moves the request to **awaiting second approval** and
notifies the other managers (N28). Unsuspend, unyank, relist and tier changes
started from the console are created that way: your action is the first
approval.

## Auto-approval rules

Two rules are seeded:

- **Verified updates**: patch/minor versions and text-only listing updates from
  Verified publishers.
- **Official catalog**: patch/minor versions and text-only listing
  updates of existing Official listings, only from the
  `official-catalog-loader` service account, at most **1 version per listing
  and 50 per day**. `OFFICIAL_AUTO_APPROVAL_ENABLED=false` turns it off for the
  whole instance.

Every rule also requires a signed, scanned image with no new critical or high
vulnerabilities and no new secrets, egress hosts, required inputs or root. The
digest is always the one pinned at submit. Security-lane requests are exempt
from the caps.

**Changes.** Disabling, deleting or tightening a rule applies at once. Creating
a rule, enabling it again or widening it (more kinds, tiers or bumps, higher
caps, dropping the submitter pin or text-only restriction) becomes a **pending
change** that a second manager applies. Watch the per-rule "approved today"
count: a sudden jump is the "auto-approval rate anomaly" alert.

## Bootstrap exception

On a fresh instance, `init-platform.sh` loads the Official catalog as the
`official-catalog-loader` service account. While the instance has **no
listings**, those requests are approved automatically by `system` and audited
as `plugin.request.auto-approve` with `details.bootstrap = true`. The window
opens with the first such request and stays open for the initial load
(`ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS`, default 24). It closes **for good** when
the window elapses, when any manager decides a request, or if the instance
already had listings. The overview shows its state. Later loads are covered by
the Official catalog rule instead.

### An Official plugin is missing after a load

A plugin reaches tenants only as a listing, so an Official plugin whose
request was refused is invisible outside the system org. The loader's upload
still answers 202; the refusal is on the build's log stream as
`Publish request: <reason>` and nothing is queued. Usual causes:

- a failing submit gate: no `license` in the spec, no `README.md` in the plugin
  directory, the image **not scanned** (grype unavailable in the plugin
  service: vulnerability scanning must work for the catalog to list), or criticals above
  `ECOSYSTEM_VULN_GATE_MAX_CRITICAL`;
- the `official-catalog-loader` account lacking `plugins:publish` (its
  "Official Catalog Loader" role).

Fix the cause and re-run `load-plugins.sh --category <c>` (a listed version
answers 409 and is skipped; an unlisted one is re-uploaded and requested again).

## Publishers and listings

| Action | Effect | Needs |
|--------|--------|-------|
| Suspend publisher | Hidden from the directory, can't submit requests, every image re-signed with trust `unverified`; publisher told (N8) | step-up |
| Unsuspend publisher | Two-person; re-sign with the real tier | step-up, second approver |
| Tier → Verified | Two-person; re-sign | step-up, second approver |
| Tier → Community | At once; re-sign; publisher told | step-up |
| Listing → unmaintained | Stays public with a banner; installs keep working | step-up |
| Listing → suspended | Hidden; the verify cache is dropped | step-up |
| Suspended → listed | Two-person | step-up, second approver |
| Yank a version | Stops resolving for new synths; the `public/*` tag is removed (pipelines pinned by digest keep pulling); publisher told (N8) | step-up |
| Unyank | Two-person; the tag is restored | step-up, second approver |

**Takedown** (policy violation, malware): suspend the listing (or the
publisher), then yank the affected versions. Both take effect at the next
lookup.

**Reserved names** (the **Reserved names** tab, `plugins:moderate`). Hold
back a handle or listing name (a vendor's brand, a confusable). A name reserved
for a publisher is claimable by that publisher only; a name reserved for nobody
refuses everyone, and claims come to the queue. Adding and removing apply at
once and are audited as `ecosystem.reserved-name.update`. The built-in reserved
words (`official`, `pipeline-builder`, …) aren't listed; they can't be removed.

## Re-sign job

Tier changes, suspensions, handle changes and transfers queue a **re-sign** of
every published image of the publisher (or listing), with the current tier and
publisher as signed annotations, then drop the lookup verify cache. The job
runs in the plugin service's maintenance scheduler (every 15 minutes,
leader-locked), resumes where it stopped after a failure, and shows on the
overview. image-registry audits each image (`registry.image.resign`).
Progress is on the dashboard (`ecosystem_resign_images_total`,
`ecosystem_resign_jobs_pending`); `EcosystemResignFailures` and
`EcosystemResignStalled` fire when it keeps failing or stops moving.

After rotating the **plugin-signing key**, nothing in `public/*` is re-signed by
itself: run **Re-sign all published images** (`POST /api/plugins/ecosystem/resign`,
with a reason) so every listed version is signed with the new key.

## Plan effects

The same scheduler watches publishers' plans (see [Plans and limits](../plugin-publishing.md#plans-and-limits)):

- a Verified publisher whose plan drops below Team gets a 30-day grace period
  (N29, reminders at 14 and 3 days), then returns to Community with a re-sign
  (`publisher.tier.change`, `reason: plan_downgrade`);
- a publisher over its listings limit is told once (N29); its listings stay
  listed and only the security lane accepts new versions until it is back
  under.

## Review moderation

The console's **Review moderation** tab lists the open queue (held reviews,
and published reviews with unresolved reports) newest activity first, and,
under **Removed**, reviews already taken down. Each item shows the listing,
the stars, the rendered body, the author's display name and user id (never
their organization), the verified-use badge, why it is held, its reports
(category, reason, date) and the publisher's reply. No step-up is asked:
hiding or restoring user content is reversible, and every decision is audited.

Why a review is held (`holdReason`):

| Reason | Trigger | What to check |
|--------|---------|---------------|
| `reports` | Three different people reported it (`REVIEW_AUTO_HOLD_REPORTS`) | Read the reports; release if they're wrong, remove if they're right |
| `burst` | Five or more reviews from organizations with no verified use of the plugin arrived on the listing within an hour | Look for a ring: same wording, new accounts, the same rating; remove the fakes, release the genuine ones |
| `filter` | More than three links in the title and body | Spam almost always; release a genuine review with reference links |
| `security` | Someone reported it as a security issue | The publisher and moderators got N19 and a private advisory draft was opened (Advisories tab). Keep it held while the advisory is handled, then release or remove it; never paste exploit details into a removal reason |
| `moderator` | A manager held it | The hold reason says why |

Decisions:

- **Hold** (reason required): takes a published review out of the directory
  and the score at once. `plugin.review.hold`.
- **Release** (optional note): publishes it, resolves its open reports, puts it
  back in the score and tells the publisher (N15). On a published review it
  only clears the reports. `plugin.review.release`.
- **Remove** (reason required): final. The author is told why (N18,
  transactional) and can't edit it any more; it leaves the score.
  `plugin.review.remove`.
- **Remove reply** (reason required): deletes the publisher's reply.
  `plugin.review.reply.delete` with `details.by: moderator`.

N17 tells moderators about new holds in-app, with a daily email digest (09:00
UTC). The directory score is refreshed on every decision; the full
`plugin_stats` sweep (ratings, installs, adoption) runs every 15 minutes,
leader-locked. A failed refresh is counted in
`ecosystem_stats_refresh_failed_total`, holds in
`ecosystem_review_holds_total{reason}`, and security reports that couldn't
open an advisory draft in
`ecosystem_review_security_reports_total{outcome="unhandled"|"failed"}`: open
that draft by hand.

To make reviews read-only instance-wide (an abuse wave), set
`PLUGIN_REVIEWS_ENABLED=false` on the plugin service; moderation keeps working.

## Anonymous submissions

People who are not signed in can submit a plugin at `/plugins/submit` when
`ANONYMOUS_SUBMISSIONS_ENABLED=true` **and** outbound email works (platform
answers `GET /internal/notify-email/status` with `enabled: true`). It is off
by default.

How a submission moves:

1. The submitter uploads a zip with an email address and a proof-of-work.
   The zip goes to the `plugin-quarantine` bucket. Nothing else is created.
2. They confirm the email link. The submission becomes `pending_review`.
3. The plugin service builds it on the **quarantine builder**: a separate
   buildkitd with no credentials and no service-account token. It has its own
   network (docker `quarantine-network`) or its own NodePool (EKS
   `plugin-quarantine`), and egress only to package mirrors and the registry.
   The image goes to `quarantine/<submissionId>`, which only the plugin
   service can pull or push. Neither a tenant nor a superadmin can list it.
4. Automated gates run. If any fails, the submission becomes `gate_failed` and
   the submitter is emailed. If all pass, a `submission` request joins the
   standard lane.
5. Two managers approve it, as for a new listing. It is then published to
   `public/community/<name>` at tier `unverified`.

Deciding a `submission` request: the review shows the gates, the SBOM and
scan, and the heuristics findings (medium findings are shown only to you).
Reject with a reason: the submitter gets it by email. There is no submitting
org, so conflict-of-interest never applies. Emails are never shown.

Cleanup is automatic:

- Zips expire from the bucket after 30 days.
- Once a submission is decided or expired, the plugin service calls
  image-registry `DELETE /internal/quarantine/<submissionId>`, which removes
  every manifest in the repo.
- image-registry also sweeps `quarantine/*` every 6 hours and deletes repos
  whose newest image is older than 30 days. This runs whatever
  `REGISTRY_GC_ENABLED` says.
- The dashboard's *Anonymous submissions* row shows the backlog, gate
  failures, and quarantine repos and bytes. Quarantine bytes never count
  toward any org's storage quota.

When something goes wrong:

| Symptom | What to do |
|---------|-----------|
| A flood of submissions (`SubmissionBacklogHigh`, or heuristics or secrets on `SubmissionGateFailureSpike`) | Set `ANONYMOUS_SUBMISSIONS_ENABLED=false` and restart the plugin service; the API returns 404 and the Submit button links to sign-in. To make the flood more expensive, raise `SUBMISSION_POW_DIFFICULTY` by 1–2 (each bit doubles the client's work). nginx also limits the three POST routes to 6 per minute per client IP (burst 5). |
| Every submission fails `vuln-scan` or `smoke-test` | A broken gate, not bad plugins. Check the grype DB (`PluginVulnRescanStale`) and the quarantine builder: `kubectl -n pipeline-builder get pods -l app=plugin-quarantine-builder` (docker: `docker ps --filter name=buildkitd-quarantine`). |
| Submissions stay `pending_review` and never build | The quarantine builder is down, or on EKS its NodePool cannot launch nodes (`kubectl describe nodepool plugin-quarantine`). The plugin service never falls back to the tenant builder. |
| Submitters get no email | Check platform SMTP. While email is off, the API returns 404 `SUBMISSIONS_DISABLED`. |

Never loosen the quarantine builder's isolation to fix a build. It has no
env, no secrets, no token, and a narrow NetworkPolicy and mesh policy.
`test/deploy-contracts/test/quarantine-builder-contract.test.ts` fails if any of
that changes.

## Audit

Every decision is recorded with `orgId` = the system org and `affectedOrgId` =
the publisher's org, so the system org's audit view is the complete record.
Use the **Ecosystem** and **Moderation** quick filters. Key actions:
`plugin.request.approve`, `plugin.request.second-approve`,
`plugin.request.reject`, `plugin.request.auto-approve`,
`plugin.listing.publish`, `plugin.listing.state.change`, `plugin.version.yank`,
`plugin.version.unyank`, `publisher.suspend`, `publisher.tier.change`,
`ecosystem.auto-approval-rule.*`, `ecosystem.reserved-name.update`,
`plugin.review.hold`, `plugin.review.release`, `plugin.review.remove`,
`plugin.submission.approve`, `plugin.submission.reject`,
`plugin.submission.gate-fail`, `plugin.submission.expire`,
`plugin.submission.claim`, and `registry.gc` for quarantine cleanup.

## Kill switches

Instance flags (plugin service env; restart to apply). The per-publisher
**suspend** and per-listing **suspend / yank** actions above are the targeted
switches; these turn a whole surface off.

| Flag | Default | Off means |
|---|---|---|
| `PUBLIC_DIRECTORY_ENABLED` | on | `/plugins` and `/api/public/plugins*` return 404 |
| `PLUGIN_PUBLISHING_ENABLED` | on when billing is on (hosted), off otherwise | tenants can't submit requests; existing listings still resolve |
| `PLUGIN_REVIEWS_ENABLED` | on | reviews are read-only |
| `ANONYMOUS_SUBMISSIONS_ENABLED` | **off** | the submission API returns 404; Submit becomes a sign-in link |
| `OFFICIAL_AUTO_APPROVAL_ENABLED` | on | the Official catalog rule never fires; every Official update waits for two-person approval |

Full descriptions: [Environment Variables](../environment-variables.md).

## Staffing

At launch, plan for about 0.5 FTE of Ecosystem Managers for roughly 100
requests a week with at least half auto-approved, and **at least three** role
holders. Revisit monthly from the queue depth and decision-latency panels of
the Plugin ecosystem dashboard (`ecosystem_requests_pending`,
`ecosystem_decision_latency_seconds`, `ecosystem_auto_approvals_total`).
