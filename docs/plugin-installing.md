---
layout: default
title: Plugin Installing
image: /assets/og-image-plugins.png
---

# Plugin Installing

The **plugin ecosystem** is the directory of plugins published by the platform and by other organizations. To use one of those plugins in your pipelines, your organization **installs** its listing. An install says which listing you use and which of its versions may resolve. Your organization's **consumption policy** decides which listings may be installed at all, which need an admin's approval, and which ones get your secrets.

Your own organization's plugins need no install. They resolve by name, as they always have. Official plugins need no install either (see [Implicit Official installs](#implicit-official-installs)).

This page is for pipeline authors and org admins. To put your own plugin in the directory, see [Plugin Publishing](plugin-publishing.md).

## Finding plugins

- **The public directory** at `/plugins` lists every listed plugin. Anyone can browse it without signing in. Each plugin page shows its README, versions, trust tier, required configuration, supply-chain details (signature, digest, vulnerability scan, SBOM) and a copyable pipeline reference.
- **The in-app catalog** (dashboard → Plugins) shows the same listings with your organization's state: installed or not, the version your pipelines resolve to now, whether installing needs approval, and whether your policy blocks it. It also shows the reference to paste into a pipeline.

A listing is a plugin name published by a publisher, written `@acme/terraform-plan` in the UI and `{ publisher: acme, name: terraform-plan }` in a pipeline.

## Trust tiers

Every listing carries its publisher's trust tier. The badge always sits beside the plugin icon.

| Tier | Who publishes it | Installed by default |
|------|------------------|----------------------|
| **Official** | The platform's own catalog (publisher `pipeline-builder`) | Yes, implicitly |
| **Verified** | Team and Enterprise publishers approved by the system org | No |
| **Community** | Any signed-in organization, each listing approved by the system org | No |
| **Unverified** | Anonymous submissions that passed automated checks and human moderation | No |

The tier is part of each image's signature. At lookup the platform checks that the signed tier and publisher still match the publisher's current tier and handle. If they don't, the step fails with `409 IMAGE_VERIFICATION_FAILED`.

### Community submissions (Unverified)

Unverified listings come from people **without an account**, through the directory's **Submit a plugin** page (see [Submitting without an account](plugin-publishing.md#submitting-without-an-account)). They're all published under the platform's `community` publisher, as `community/<name>`.

- **What was checked.** Each version was built in an isolated sandbox with no credentials, and passed every automated check: spec, contract and license validation, Dockerfile lint, not running as root, a vulnerability scan, a scan for crypto-miners, obfuscated shell and credential access, no secret-looking defaults, and a passing smoke test. Then two Ecosystem Managers approved it.
- **What wasn't.** Nobody's identity. The submitter only confirmed an email address, so "signed" means "built by the platform from this source", not "vouched for by someone you know". Read the plugin's source and Dockerfile before you rely on it.
- **Your policy blocks them by default.** Unverified isn't in the default `allowedTiers`, so these listings can't be installed and don't resolve (`PLUGIN_BLOCKED_BY_POLICY`, reason `tier`).

**To allow Unverified listings** (needs `plugin_installs:manage` and a recent re-authentication):

1. Open **dashboard → Plugins → Policy**.
2. Add **Unverified** to **Allowed tiers**.
3. Leave it in **Tiers that need approval** (the default), so each install is decided by an admin under **Plugins → Approvals**.
4. Leave it **out** of **Tiers that get secrets** (the default), so these plugins never receive your secrets. A step that declares secrets still runs, without them, and warns `PLUGIN_SECRETS_WITHHELD`.

Allowing the tier doesn't install anything: each community plugin still needs its own install, and, with the defaults above, an admin's approval. To keep particular community listings out entirely, add them to `blockedListings`.

A pipeline references a community plugin with the `community` publisher: `plugin: { publisher: community, name: <name> }`. If the submitter later claims the listing with an account, it moves to their publisher like a transfer and its images are re-signed with the new publisher.

## Installs

Install a listing from its catalog page (**Install**). Installing needs `plugins:install`, which members, admins and owners hold.

- If your policy requires approval for the listing's tier (by default Community and Unverified), and you don't hold `plugin_installs:manage`, the install becomes a **pending request**. Your org's approvers are notified and decide it under **Plugins → Approvals**. You're told the outcome.
- If you hold `plugin_installs:manage`, or the tier needs no approval, the install is active at once.
- A **paused** listing takes no new installs (`PLUGIN_UNAVAILABLE`, reason `paused`). Existing installs keep working.
- A listing your policy blocks, or whose tier your policy doesn't allow, can't be installed (`PLUGIN_BLOCKED_BY_POLICY`).
- You can withdraw your own pending request, and uninstall an active install.

Installing is **free on every plan** and doesn't count against any quota.

### Version policies

Each install has a version policy. It decides which versions a new synth may resolve to.

| Policy | Resolves to | Example (installed at `1.4.2`) |
|--------|-------------|--------------------------------|
| `pinned` | Exactly the installed version | `1.4.2` only |
| `patch` | New patch versions (`~installed`) | `1.4.x` |
| `minor` (default) | New minor and patch versions (`^installed`) | `1.x` |
| `latest` | The newest stable version, but never across a version the publisher marked `breaking` | `1.x`, and further until a `breaking` version |

**A new major version never flows in on its own.** You're told it's available (with the changelog and the vulnerability delta), and you upgrade when you choose.

A pipeline step can narrow the install's range with `filter.version` (see [Referencing plugins](#referencing-plugins)). It can never widen it: a version outside the install's range fails with `PLUGIN_NOT_INSTALLED`, reason `version_outside_install`.

### Upgrading

Upgrading means changing an install's version or its policy (the install's **Upgrade** action, or `PATCH /api/plugins/installs/:id`). It needs `plugins:install`. For a listing whose tier requires approval, moving across a major or `breaking` version, or switching the policy to `latest`, needs `plugin_installs:manage`. The install views say so ahead of time: `needsApproval: true` on a catalog entry or an install means such a change needs an approver for you. A team can't change or remove an install it inherits from its root organization.

Without `plugin_installs:manage` you **request** the change instead (`POST /api/plugins/installs/:id/change-requests` with `{ version?, versionPolicy?, note? }`). The request is stored on the install as its one pending change (`pendingChange` on the install), your organization's approvers are notified (N11), and they approve it (the change is applied, re-checked against your policy at that moment) or reject it with a reason under **Plugins → Approvals**. You're told the outcome (N12). A change that needs no approval is refused as a request — apply it directly.

Deployed pipelines keep running the image digest they were synthesized with. A new version reaches a pipeline on its next synth.

### Which versions never resolve

- **Yanked** versions never resolve for a listing, even when pinned. A pin to one fails with `PLUGIN_UNAVAILABLE`, reason `yanked`.
- **Paused** versions are skipped by range resolution, unless the install already resolved to that version or the step pins it exactly.
- Versions with a published advisory at or above your `blockOnAdvisory` level are skipped. A pin to one fails with `PLUGIN_BLOCKED_BY_POLICY`, reason `advisory`.
- **Deprecated** versions still resolve, with a warning at synth.
- Versions **flagged by a rescan** still resolve, with a `VULN_FLAGGED` warning, unless the instance blocks them (see [Vulnerability scans and rescans](#vulnerability-scans-and-rescans)).

### Vulnerability scans and rescans

Every plugin version's image is scanned when it's built, and rescanned every night. A build with more **fixable** Critical findings than the instance allows never gets stored (see [Scan gates](plugin-publishing.md#scan-gates)). A finding is fixable when a fixed version of the affected package is known. The plugin list, plugin details, the directory's versions and supply-chain tabs and the Publisher page show:

- the Critical and High counts, each as **fixable / total**;
- **Unscanned** for a version stored without a scan (only when the operator allows unscanned builds);
- **Flagged by rescan** when a later rescan found fixable Critical findings the build didn't have. Its tooltip, and the plugin details, list the top findings and the versions that fix them.

A flagged version still resolves by default. Lookup answers with a warning, which synth, `pipeline-manager` and the pipeline editor show:

```text
VULN_FLAGGED: trivy@1.4.0 has 2 fixable Critical findings — rebuild or upgrade
```

When the operator sets `PLUGIN_BLOCK_ON_NEW_CRITICAL=true`, flagged versions are skipped instead. A version range, `latest` or the default resolves to the newest satisfying version that isn't flagged, the same way advisory-blocked versions are skipped. An exact version or digest pin to a flagged version fails with `409 PLUGIN_VERSION_VULN_BLOCKED`, and the message names the fix. This applies to your organization's own plugins and to listings.

Your organization decides who is told about rescan findings under **Settings → Organization → Plugin security notifications** (see [Notifications](#notifications)).

## Implicit Official installs

Every organization can use Official plugins (publisher `pipeline-builder`) without installing them. This is an **implicit install**:

- It's virtual. Nothing is stored per organization, so an Official plugin added later reaches every organization immediately.
- Its policy is `minor`, inside the lowest live major (`<major>.x`). Patch and minor versions flow automatically; a new major never does.
- In a pipeline step, an explicit `filter.version` replaces the implicit range. For example, `filter: { version: '^2' }` selects the 2.x line.
- Create an **explicit** install to pin a version, change the policy or move to a new major. It overrides the implicit one.
- Uninstalling an explicit Official install falls back to the implicit one.
- An org whose policy sets `officialInstalls: explicit` has no implicit installs. Its pipelines resolve only the Official listings it installed (`PLUGIN_NOT_INSTALLED`, reason `official_explicit`, otherwise).

## Referencing plugins

A pipeline step names its plugin. A `publisher` makes the reference **qualified**.

```yaml
# Your org's plugin, else your parent org's, else the Official listing
plugin: { name: trivy }

# Only acme's listing, only through your install, narrowed to 1.x
plugin: { publisher: acme, name: terraform-plan, filter: { version: '^1' } }

# The Official listing, named explicitly
plugin: { publisher: pipeline-builder, name: trivy }
```

### Resolution order

**Unqualified** (`{ name: trivy }`):

1. your organization's own plugin of that name;
2. for a team, its parent organization's shared (`public`) plugin;
3. the Official listing `pipeline-builder/<name>`, through your install: an explicit install, else the implicit one.

**Qualified** (`{ publisher: acme, name: … }`): only acme's listing, and only through an install. Your own plugins are never considered. `publisher: pipeline-builder` names the Official listing.

`public` visibility only shares a plugin with your organization and its teams. It never reaches another organization, including the system org's plugins. Only listings do.

### Shadowing

If your organization has its own plugin with the same name as an Official listing, **your plugin wins** for unqualified references. This is **shadowing**. The platform tells you about it:

- lookup answers with the warning `PLUGIN_SHADOWS_LISTING`, which synth prints;
- the Plugins page flags your plugin, and the pipeline editor flags each step that uses it;
- `GET /api/plugins/shadowing` lists every shadowed name.

To use the Official listing instead, add `publisher: pipeline-builder` to the step, or rename or delete your plugin.

### What pipeline create and update check

Creating or updating a pipeline (in the UI, the API, the CLI or bulk) resolves every plugin reference the way synth does, and refuses the pipeline with `400 TEMPLATE_CONTRACT_VIOLATION` and the per-step reasons (`details.steps[].refusal`) when a qualified reference, or an unqualified one that falls back to an Official listing:

- names no listing, isn't installed, or its install is pending or denied;
- is blocked by your policy;
- can't resolve (for example, no version in range, or only yanked versions).

An unqualified reference that matches nothing at all is not refused (it may be created as a placeholder).

The plugin contract (`requiredMetadata`, `requiredVars`) is checked for listed versions too.

### At synth

- `pipeline-manager` passes the `publisher` through to lookup.
- The image comes from lookup's `imageRepository`: `public/<publisher>/<name>` for every listing (Official included), `org-<id>/<name>` for your own plugins. Synth pins `<repository>@<digest>`.
- Lookup verifies the image signature, and for a listing also the signed trust tier and publisher.
- CDK construct IDs and artifact-key aliases include the publisher. A qualified reference's default alias is `<publisher>-<name>-alias`, and its step construct id is `<publisher>-<name>` when the step has no alias. Unqualified references are unchanged.

## Consumption policy

Your organization's consumption policy decides what *your* pipelines may use. It never affects the ecosystem or other organizations. Edit it under **dashboard → Plugins → Policy**. Changing it needs `plugin_installs:manage` (admins and owners) and a recent re-authentication. Every change is audited (`org.plugin-install-policy.update`).

| Field | Values | Default | Effect |
|-------|--------|---------|--------|
| `allowedTiers` | Official, Verified, Community, Unverified | Official + Verified | Listings from other tiers can't be installed and don't resolve (`PLUGIN_BLOCKED_BY_POLICY`, reason `tier`). |
| `requireApprovalTiers` | the same | Community + Unverified | Installing a listing from these tiers, without `plugin_installs:manage`, creates a pending request. |
| `secretsAllowedTiers` | the same | Official + Verified | Listings from other tiers get **no secrets**, even if their spec declares them. Lookup removes them and warns `PLUGIN_SECRETS_WITHHELD`. |
| `blockOnAdvisory` | `critical`, `high`, `never` | `critical` | Versions with a **published** advisory at or above this severity don't resolve (reason `advisory`). |
| `officialInstalls` | `implicit`, `explicit` | `implicit` | `explicit` turns off implicit Official installs, so every Official listing must be installed on purpose (through the approval flow, if it applies). Meant for regulated organizations. |
| `blockedListings` | list of `publisher/name` | empty | These listings don't resolve and can't be installed, **including Official ones** (reason `blocked_listing`). |

**No safety control is plan-gated.** Every plan gets the full policy.

A compliance rule can express the same limits, when you need an audited "never" rather than a setting.

## Teams

- A root organization's installs and policy apply to all its teams.
- A team may add its own installs. They apply only to that team and never propagate up to the root.
- A team may save its own policy. It's merged with the root's and can only be **stricter**:

| Field | How the team's and root's values combine |
|-------|------------------------------------------|
| `allowedTiers` | Intersection (only tiers both allow) |
| `requireApprovalTiers` | Union |
| `secretsAllowedTiers` | Intersection |
| `blockOnAdvisory` | The stricter level |
| `officialInstalls` | `explicit` wins |
| `blockedListings` | Union |

## Approvals

Holders of `plugin_installs:manage` see pending requests under **Plugins → Approvals**, with the listing, tier, version policy and requester. **Approve** activates the install; **Deny** closes it. The requester is told either way.

For a team, the approvers are the team's holders of `plugin_installs:manage`; if there are none, the root org's; if nobody holds it, the owners.

## Notifications

Notices go to your organization only. Publishers never learn who installed their plugin.

| # | When | Who | How |
|---|------|-----|-----|
| N11 | An install is requested | Org approvers | In-app + email, immediate (email opt-out `ecosystem.installs.email`) |
| N12 | Your request is approved or denied | The requester | In-app + email |
| N13 | A new version is available **outside** an install's range | Org approvers | In-app; weekly email digest. A `breaking` major is sent at once. Includes the changelog and vulnerability delta. |
| N27 | An installed listing moved to a new version **within** its range | Org approvers | In-app; weekly email digest, with the changelog and vulnerability delta |
| N14 | A listing you use is deprecated or unmaintained | Installing orgs | In-app + email |
| N26 | A listing or version you use was paused by its publisher | Installing orgs | In-app |
| N8 | A listing or version you use was suspended, yanked or taken down | Installing orgs | In-app + email, immediate, with the reason |
| N30 | A plugin version was blocked at build: it couldn't be scanned, or it has fixable Critical findings | Your plugin security recipients | In-app + email + webhook, immediate |
| N31 | A rescan found new Critical or High findings in a plugin version | Your plugin security recipients | In-app + email + webhook; follows your digest setting, and sent once per version and set of findings |

"Installing orgs" means organizations with an active explicit install, plus, for Official listings, organizations whose pipelines use the listing through the implicit install. The notice goes to each organization's approvers.

### Plugin security notifications

N30 and N31 go where your organization says, under **Settings → Organization → Plugin security notifications**. Anyone with `plugins:read` can see the settings; changing them needs `org:settings`.

| Setting | Default | What it does |
|---------|---------|--------------|
| Recipients | The uploader and everyone who can write plugins | Or only the members you choose. |
| Rescan findings | On | Turn off to stop N31. Blocked versions (N30) are always sent. |
| Rescan delivery | Immediately | Or a daily or weekly digest. N30 is never batched. |
| Webhook URL | None | An `https` URL that gets each notice as JSON. With a signing secret, every delivery carries `X-PB-Signature: sha256=<HMAC>`. The secret is never shown again once saved. |
| External address | None | One address outside your organization, such as a security team's mailbox. Saving it emails that address a confirmation link, valid for 24 hours and usable once. The link opens a page with a **Confirm address** button, so mail scanners that open links can't confirm it. The address gets nothing until it's confirmed. You can resend the link or remove the address. |

**Send test** sends a test notice to every configured channel, so you can check the webhook and the addresses before a real notice.

## Reviews and ratings

Anyone can read reviews on a plugin's public page (**Reviews** tab). To write one, sign in: guests see **Write a review** as a sign-in link that brings them back to the tab.

- **One review per person per plugin.** Rate it 1 to 5 stars, with an optional title (up to 120 characters) and body (Markdown, up to 5,000 characters), and the version you used. Edit or delete it at any time; edits keep the earlier text in the review's history.
- **Markdown is rendered on the server.** Raw HTML is dropped, images aren't shown, and links get `rel="nofollow ugc noopener"`.
- **Only your display name is shown**, never your organization.
- **Verified use.** The badge appears when your organization ran the plugin successfully in the last 90 days. It never names the organization.
- **Only people write reviews.** Service accounts and access keys get `HUMAN_SESSION_REQUIRED`, for votes, reports and replies too.
- **You can't review your own organization's plugins**, or vote on their reviews (`REVIEW_SELF_PROMOTION`).
- **Helpful.** Mark other people's reviews helpful, once each. Votes aren't audited.
- **Report.** Report a review as spam, abuse, off-topic or a **security issue**. A security report is never posted: the review is hidden, the publisher's managers and the platform moderators are told privately, and a private advisory draft is opened. Several reports on one review hide it until a moderator looks at it.

### How the score works

The score is a Bayesian average: every plugin starts at 3.5 stars, worth 10 votes, so a handful of reviews can't swing it. Verified-use reviews count fully and other reviews count half. The page shows the score, the number of ratings, the star distribution and a **Recent versions** score over the last two minor versions. Reviews waiting for moderation, and removed ones, don't count. The directory's **Top rated** and **Most installed** sorts use these numbers, which are refreshed on every review and every 15 minutes. Installs count organizations with an install or a pipeline that uses the plugin; the count of organizations actively running it is shown only from 5 upward.

### Limits and moderation

Each organization can post 20 new reviews a day, and so can each network address. Writes are also throttled per person. A review is held for moderation instead of published when it has more than three links, when a burst of reviews from organizations that haven't used the plugin arrives on one listing, or after reports. Held reviews are invisible to everyone except you: your review shows *awaiting moderation*. If a moderator removes it, you're told why (notice N18) and can't edit it any more.

| # | When | Who | How |
|---|------|-----|-----|
| N15 | A review is posted or edited on your listing | Publisher managers | In-app; email batched hourly per listing (opt-out `ecosystem.reviews.email`) |
| N16 | The publisher replied to your review | The review author | In-app + email (opt-out `ecosystem.reviews.email`) |
| N18 | A moderator removed your review | The review author | In-app + email, with the reason |
| N19 | A review was reported as a security issue | Publisher managers and moderators | In-app + email, immediate, private |

`PLUGIN_REVIEWS_ENABLED=false` makes reviews read-only on an instance (`PLUGIN_REVIEWS_DISABLED`).

## Health score

Every listing carries a **health score** from 0 to 100. It's a quick read on how well a plugin is looked after, shown as a **Health** badge on directory cards and plugin pages (good at 80 and above, fair from 50, poor below). The plugin page's **Health** panel lists each signal, its score and its share of the total.

| Signal | Weight | How it scores |
|--------|:------:|---------------|
| Runtime success (30 days) | 25 | Share of the plugin's steps that succeeded across every organization in the last 30 days. Counted only after 20 runs. |
| Known vulnerabilities | 20 | The latest listed version's scan: 1 with no critical or high findings, minus 0.5 per critical and 0.1 per high, never below 0. Left out until the version is scanned. |
| Freshness | 15 | The age of the latest release (full marks up to 90 days, falling to zero at 540), averaged with the age of its base image (full marks up to 60 days, zero at 365) when the base image's build date is known. |
| Signed image | 10 | The listed version has an image digest and the platform's signature. |
| Smoke test declared | 10 | The spec declares a `smokeTest`. |
| README and license | 10 | Half for a README, half for a license. |
| Rating | 10 | The Bayesian rating out of 5. Counted only after 3 ratings. |

A signal without enough data is left out and the remaining weights are scaled up to 100, so a new plugin isn't marked down for having no runs or reviews yet. With fewer than three signals there is no score at all. Scores are recomputed every 15 minutes, with the review and install numbers.

- **Base image age** is recorded when a version is published: the build date of the image the plugin's Dockerfile builds `FROM`, read from the build's provenance (or the Dockerfile's own reference). When it can't be read, freshness uses the release age alone.
- **Sort by health.** The directory's **Health** sort (`sort=health` on `GET /api/public/plugins`) orders results by score; plugins without one come last.
- **In the API.** Search results carry `healthScore`; a plugin page's data adds `healthBreakdown` (`{ <signal>: { score, weight } }`, `score` null when left out) and `successRate30d`. The in-app catalog, install state and publisher listings carry `healthScore` too.
- **AI pipeline generation** ranks the plugins it may use: your organization's own first, then Official, then Verified, then the rest, and within each group by health. It tells the model each plugin's trust tier, health and rating, and flags paused and unmaintained listings so they're only picked when you ask for them by name. Similar-plugin hints use health to break ties.
- **Publishers** see each listing's score and breakdown, installs, active organizations (shown as "<5" below five), 30-day success rate, 12-month rating trend, open review reports and open advisories on the publisher page's **Insights** tab (`GET /api/plugins/publisher/insights`, `plugins:read`). A publisher's own score is the install-weighted average of its live listings.

## Audit

Install and policy actions are recorded in your organization's audit log, with `affectedOrgId` = your organization: `plugin.install.create` (no approval needed), `plugin.install.request`, `plugin.install.approve`, `plugin.install.deny`, `plugin.install.upgrade` (`details.from` / `details.to`), `plugin.install.change-request`, `plugin.install.change-approve` / `plugin.install.change-reject` (an approval-gated change a member asked for, and its decision), `plugin.install.remove` (`details.withdrawn` for a withdrawn request) and `org.plugin-install-policy.update` (the changed fields, before and after). The audit page's **Ecosystem** quick filter shows them. See [Audit Events](audit-events.md).

## API

All routes are under `/api` and need a signed-in caller.

| Method | Endpoint | Permission | Purpose |
|--------|----------|------------|---------|
| `GET` | `/plugins/catalog?q=&category=&installed=` | `plugins:read` | The catalog with your install state |
| `GET` | `/plugins/listings/:publisher/:name/install-state` | `plugins:read` | One listing's install state and versions |
| `GET` | `/plugins/installs?status=&implicit=` | `plugins:read` | Your installs, optionally with the implicit Official ones |
| `POST` | `/plugins/installs` | `plugins:install` | `{ publisher, name, versionPolicy?, version? }` → 201, status `active` or `pending_approval` |
| `PATCH` | `/plugins/installs/:id` | `plugins:install` | Upgrade: change the version or policy |
| `DELETE` | `/plugins/installs/:id` | `plugins:install` | Uninstall, or withdraw a pending request |
| `POST` | `/plugins/installs/:id/approve` | `plugin_installs:manage` | Approve a pending request |
| `POST` | `/plugins/installs/:id/deny` | `plugin_installs:manage` | Deny a pending request |
| `POST` | `/plugins/installs/:id/change-requests` | `plugins:install` | `{ version?, versionPolicy?, note? }` → 201 `{ changeRequest }`: request a change that needs an approver |
| `GET` | `/plugins/installs/change-requests` | `plugin_installs:manage` | `{ changeRequests: [{ installId, listing, from, to, requestedBy, requestedAt, note }] }`, oldest first |
| `POST` | `/plugins/installs/:id/change-requests/approve` | `plugin_installs:manage` | Apply the pending change → `{ install }` |
| `POST` | `/plugins/installs/:id/change-requests/reject` | `plugin_installs:manage` | `{ reason? }` → `{ install }`: drop the pending change |
| `GET` | `/plugins/install-policy` | `plugins:read` | Your policy and the effective (merged) one |
| `PUT` | `/plugins/install-policy` | `plugin_installs:manage` + step-up | Save your policy |
| `GET` | `/plugins/shadowing` | `plugins:read` | Your plugins that shadow an Official listing |
| `GET` | `/plugins/listings/:publisher/:name/review-state` | `plugins:read` | Your review, your votes and reports, and whether you may review or reply |
| `POST` | `/plugins/listings/:publisher/:name/reviews` | `plugins:read` + a person | `{ rating, title?, body?, version? }` → 201 |
| `PATCH` | `/plugins/reviews/:id` | `plugins:read` + a person | Edit your review |
| `DELETE` | `/plugins/reviews/:id` | `plugins:read` + a person | Delete your review |
| `PUT` / `DELETE` | `/plugins/reviews/:id/helpful` | `plugins:read` + a person | Mark, or unmark, a review helpful |
| `POST` | `/plugins/reviews/:id/report` | `plugins:read` + a person | `{ category: spam\|abuse\|off_topic\|security, reason? }` |

The catalog entries and install state also carry `rating` (`{ score, count }` or `null`) and `installCount`. Anonymous readers use `GET /api/public/plugins/:publisher/:name/reviews?sort=helpful|recent|highest|lowest&rating=&cursor=&limit=` (published reviews only, display names only).

`POST /plugins/lookup` and `GET /plugins/find` accept `publisher` in the filter. The answer's `plugin` carries `publisher`, `publisherTier`, `listingId`, `imageRepository`, `source` (`org` or `listing`) and `install` (`explicit`, `implicit` or `null`). `warnings` may include `PLUGIN_SHADOWS_LISTING`, `PLUGIN_SECRETS_WITHHELD`, `LISTING_UNMAINTAINED`, `PLUGIN_DEPRECATED` and `PLUGIN_YANKED`.

`GET /plugins/plugin-usage` counts unqualified references by `name` and qualified ones by `publisher/name`.

## AI pipeline generation

AI generation offers your installed listings and the implicit Official ones. It writes `publisher` on a step for any non-Official listing. Plugins it creates on the fly never take the name of a listed plugin; install the listing instead.

## Errors you may see

| Code | Status | Meaning |
|------|:------:|---------|
| `PLUGIN_NOT_INSTALLED` | 403 | The reference needs an install. `details.reason`: `not_installed`, `pending_approval`, `denied`, `official_explicit` (your policy turned off implicit Official installs) or `version_outside_install` (the step asks for a version outside the install's range). |
| `PLUGIN_BLOCKED_BY_POLICY` | 403 | Your consumption policy refuses it. `details.reason`: `tier`, `blocked_listing` or `advisory`. |
| `PLUGIN_UNAVAILABLE` | 409 | The listing or version can't be used. `details.reason`: `yanked`, `suspended` or `paused` (no new installs). |
| `PLUGIN_NAME_LISTED` | 409 | A plugin created on the fly can't take a listed plugin's name. Install the listing instead. |
| `IMAGE_VERIFICATION_FAILED` | 409 | The image's signature, or its signed tier and publisher, doesn't verify. |
| `PLUGIN_VERSION_VULN_BLOCKED` | 409 | You pinned a version a rescan flagged, and the instance blocks flagged versions (`PLUGIN_BLOCK_ON_NEW_CRITICAL`). The message names the fix. Move to a newer version, or use a range. |
| `REVIEW_SELF_PROMOTION` | 403 | You can't review, or vote on reviews of, your own organization's plugins. |
| `PLUGIN_REVIEWS_DISABLED` | 403 | Reviews are read-only on this instance (`PLUGIN_REVIEWS_ENABLED`). |
| `HUMAN_SESSION_REQUIRED` | 403 | Reviews, votes, reports and replies need a person signed in, not an access key or service account. |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many reviews. `details.reason: org_daily_limit` means your organization posted 20 today. |
| `DUPLICATE_ENTRY` | 409 | You already reviewed this plugin (edit it instead), or already reported this review. |
