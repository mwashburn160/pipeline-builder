---
layout: default
title: Plugin Publishing
image: /assets/og-image-plugins.png
---

# Plugin Publishing

Publishing puts a plugin in the **plugin ecosystem**: the public, searchable directory every organization on this instance can browse and install from. (Using listings, installs and each organization's consumption policy are covered in [Plugin Installing](plugin-installing.md).) It is separate from sharing inside your organization. The visibility ladder (`private`, `org`, `public`) still only decides who in *your* organization and its teams can see a plugin version. Nothing you set on a plugin puts it in the directory by itself.

**Only the system organization decides what enters the ecosystem.** You **request** a listing, a new version, a metadata change, a yank, a transfer or a Verified badge. The system org's Ecosystem Managers approve or reject each request, either by hand or through auto-approval rules they configure. You can always **pause** your own listing or version immediately, because that only narrows your own reach.

## Your publisher profile

A **publisher** is your organization's public identity. It has a handle (`acme`, shown as `@acme/terraform-plan`), a display name, a description, a homepage and a trust tier. Each root organization has one publisher.

- **Claim a handle** on the **Publisher** page (dashboard → Build → *Publisher*). A handle has 2–39 lowercase letters or digits, with single hyphens between them. It names your registry namespace (`public/<handle>/<plugin>`), so choose it carefully.
- **Reserved handles.** Platform words (`pipeline-builder`, `official`, `community`, `system` and others) can't be claimed. The system org can also reserve names, for example to protect a vendor's brand. If a reserved handle is yours, submit a **claim** request and the system org decides.
- **Publisher terms.** Claiming a handle means accepting the current publisher terms. When the terms change, you must accept them again before you can submit new requests. Your existing listings are unaffected.
- **Teams publish through their root org.** A team can't own a publisher. To publish a team's plugin, move it to the root organization or upload it there.
- **Profile edits.** You can change the description and homepage directly. Changes to the handle or display name are **profile change** requests, because a new name could impersonate someone.

Managing the publisher profile requires `publishers:manage`. Submitting listing and version requests, and pausing, requires `plugins:publish`. Owners and admins hold both.

## Trust tiers

| Tier | Who | How it is earned |
|------|-----|------------------|
| **Official** | The platform's own catalog (the `pipeline-builder` publisher, owned by the system org) | Every listing and version is approved by two Ecosystem Managers, except the one-time initial catalog load and gate-green routine updates from the catalog loader. |
| **Verified** | A publisher on the **Team** or **Enterprise** plan, with a DNS-verified domain and two-factor authentication on every owner, whose application the system org approved | Apply from the Publisher page. The badge is earned through review and can be withdrawn. It is never sold. |
| **Community** | Any signed-in organization, on any plan, within its listings limit | Each listing is approved by the system org. |
| **Unverified** | Anyone, without an account, through [Submitting without an account](#submitting-without-an-account). Listed under the platform's `community` publisher | Every version passes the automated checks and is approved by two Ecosystem Managers. |

The tier travels with every published image as a signed annotation (`pb.trust`), so changing a tier re-signs every image the publisher has published.

## Plans and limits

Publishing is available on every plan, within a **listings** limit: the number of live (listed or unmaintained) listings your root organization publishes.

| Plan | Listings | Verified eligibility |
|------|----------|----------------------|
| Developer | 3 | — |
| Pro | 10 | — |
| Team | 25 | Yes |
| Enterprise | 100 | Yes |
| Self-hosted (billing off) | Unlimited | Yes |

- A new-listing request is checked against the limit when you submit it (open new-listing requests count too), and again when it is approved.
- **Downgrades.** If a plan change leaves you over the limit, your listings **stay listed**. New versions and listing updates are refused until you are back under the limit, but the **security-fix lane stays open**, so your users are never stuck on a vulnerable version. You're told once (notice N29).
- **Verified eligibility is checked automatically**, when you apply and again when the system org decides. All three must hold, or the application is refused with the reason:
  - the plan includes Verified publishing (`VERIFIED_PLAN_REQUIRED`);
  - your root organization has at least one **DNS-verified domain** (Settings → Email domains); a domain you name in the application must be one of them (`VERIFIED_DOMAIN_REQUIRED`);
  - **every owner** of the organization has a passkey or an authenticator app (`VERIFIED_OWNER_MFA_REQUIRED`).

  If the checks can't be run at that moment the application is refused as unavailable (503); try again shortly.
- **Verified below Team.** If your plan drops below Team, your Verified badge stays for a **30-day grace period** (notice N29, with reminders at 14 and 3 days left). If the plan still doesn't include Verified publishing when the grace period ends, the tier returns to Community and every image is re-signed.

## Scan gates

Every plugin image is scanned for vulnerabilities when it's built: an SBOM is made with syft and scanned with grype. This applies to every build, not just published ones: uploads, prebuilt images, AI-generated plugins, bulk uploads and the catalog loader. Anonymous submissions go through the same gate.

**Fixable findings.** A finding is **fixable** when the scanner knows a version of the affected package that fixes it. The gates count **fixable Critical** findings only, because a Critical with no fix yet can't be resolved by rebuilding. Plugin views show both numbers for Critical and High, for example **2 fixable / 5 Critical**.

**A build that can't be scanned fails.** If the scan can't run, the build is retried like any other transient failure. After the last attempt it fails with `IMAGE_SCAN_UNAVAILABLE`: nothing is stored and the plugin quota the upload reserved is released. Build it again once the scanner is back.

The operator can let such builds through with `PLUGIN_ALLOW_UNSCANNED=true`. The version is then stored without a scan, shows an **Unscanned** badge, and the skip is audited (`plugin.scan.skipped`).

**The platform floor.** A version with more fixable Critical findings than `PLUGIN_VULN_MAX_CRITICAL` fails its build with `PLUGIN_VULN_GATE` (default `0`, so any fixable Critical fails; `-1` turns the floor off). The build's failure message lists the top findings and the versions that fix them. Upgrade those packages, or the base image, and build again. Your organization's compliance rules can be stricter than the floor, but not looser.

**Nightly rescans.** Stored versions are rescanned every night against the latest vulnerability data. This includes every listed version, which is rescanned from its own public image even if the organization that built it has since deleted the plugin. When a rescan finds more fixable Critical findings than the floor allows, the version is **flagged**: plugin views show **Flagged by rescan** with the top findings and their fixed versions, and pipelines that resolve it get a `VULN_FLAGGED` warning (see [Plugin Installing](plugin-installing.md#vulnerability-scans-and-rescans)). The flag clears on the first rescan that finds the findings resolved. To clear it yourself, rebuild the plugin on patched packages, or publish a new version.

**Who is told.** A blocked build (notice N30) is always reported right away. New Critical or High findings from a rescan (notice N31) follow your organization's settings. Admins set both under **Settings → Organization → Plugin security notifications**: who receives them (the uploader and everyone who can write plugins, or chosen members), whether rescan findings are sent and as a daily or weekly digest, an optional signed webhook, and one external address. The external address gets nothing until its owner opens the confirmation link and presses **Confirm address**. **Send test** sends a test notice to every configured channel.

## Requests

Every change to the ecosystem is a request. Open requests show on the Publisher page's **Requests** tab, where you can withdraw them.

| Request | What it asks for | Permission |
|---------|------------------|------------|
| New listing | List one of your plugin versions under a new name | `plugins:publish` |
| New version | Publish another version of an existing listing | `plugins:publish` |
| Listing update | Change the listing's summary, description, category, keywords, license, links, icon or README | `plugins:publish` |
| Yank | Stop a listed version resolving for new pipeline synths | `plugins:publish` |
| Unpause | Lift a pause you applied | `plugins:publish` |
| Transfer | Move a listing to another publisher (the receiving publisher must accept first) | `publishers:manage` |
| Claim | Take a reserved handle, or a listing under the platform's `community` publisher | `publishers:manage` |
| Profile change | Change your handle or display name | `publishers:manage` |
| Verified | Apply for the Verified badge (Team and Enterprise) | `publishers:manage` |

You can have at most one open request of each kind for the same listing and version.

### What a version request needs

A new-listing or new-version request is refused, with the list of failing checks, unless the version:

- has **public** visibility;
- declares an **SPDX license**;
- ships a **README**;
- if it produces an image, is **signed** (it has a digest), **scanned**, and has no more **fixable critical** vulnerabilities than the instance allows (the vulnerability gate; see [Scan gates](#scan-gates)).

### The digest is pinned

When you submit a version request, the version's image digest is recorded on the request and the version is **frozen**. From that moment it can't be re-uploaded, edited or deleted (the upload answers `409 PLUGIN_VERSION_FROZEN`). The approval publishes exactly that digest. If the stored digest changed anyway, the approval fails closed with `PLUGIN_DIGEST_MISMATCH`. Withdrawing or a rejection releases the freeze, unless the version is already listed.

### Publishing from a script or the loader

`POST /api/plugins/upload` accepts `publishRequest=true` (together with `visibility=public`). Once the build completes, the plugin service submits a new-listing request (or a new-version request if the name is already listed) as the uploader. The Official catalog loader (`deploy/bin/load-plugins.sh`) uploads every plugin this way.

### Publishing from the CLI

`pipeline-manager plugin publish --dir <plugin>` runs every local check, then submits the request with one upload:

1. **Pre-flight.** It runs the server's own checks (the spec and config schemas and the `{{ ... }}` contract, shared from api-core) and the catalog's Dockerfile rules: a non-root final `USER`, every download through `fetch-verified`, no pipe-to-shell installers. Any problem stops it before anything is uploaded.
2. **Scan preview.** It builds the image, makes an SBOM with syft and scans it with grype, as the platform will after the build. A critical vulnerability stops the publish. If syft or grype isn't installed, it says the preview did not run rather than passing silently. `--skip-scan` skips it on purpose, and `--image` scans an image you built.
3. **Accept or edit.** It shows each catalog field with its detected value and source (below) and asks you to accept, edit or clear it. `--yes` accepts everything detected. `--metadata <file.yaml>` supplies your edits without prompting, and every other detected value is accepted. The file uses the same keys and validator as the upload form, so contract keys such as `commands` are refused.
4. **Upload.** It checks your publisher profile, root organization and terms, then uploads the package with `visibility=public`, `publishRequest=true` and your edits as `metadata`. The request is submitted once the build completes.

`plugin validate --dir <plugin>` prints the same catalog report without publishing: which fields would be empty or invalid, and where each value comes from. `plugin test` runs the plugin in its image first (see [Pipeline Manager](pipeline-manager.md#author-test-and-publish-a-plugin)).

```yaml
# catalog.yaml, for plugin publish --metadata catalog.yaml
summary: Lints Terraform with tflint and the AWS ruleset.
homepageUrl: https://github.com/acme/tflint-plugin
keywords: [terraform, lint, aws]
documentationUrl: null   # null clears a detected value
```

## Catalog metadata: accept or edit

The metadata your plugin package already declares is detected and pre-filled. You accept each value or edit it.

**Where each value comes from** (the first source with a value wins):

| Field | 1. `plugin-spec.yaml` | 2. `README.md` | 3. The plugin's own Dockerfile `LABEL` |
|-------|----------------------|----------------|----------------------------------------|
| Summary (160 characters) | `summary` | — | — (then the first sentence of the description) |
| Description | `description` | first paragraph | `org.opencontainers.image.description` |
| Display name | — | first `#` heading | `org.opencontainers.image.title` |
| License | `license` | — | `org.opencontainers.image.licenses` |
| Homepage / source / documentation links | `homepageUrl` / `sourceUrl` / `documentationUrl` | — | `org.opencontainers.image.url` / `.source` / `.documentation` |
| Category, keywords, icon, changelog | spec | — | — |

- **What you can edit:** the summary, description, display name, category, keywords, license, the three links, the icon and the README.
- **What you can't edit:** anything that decides what runs, such as commands, environment, secrets, required inputs, network egress and compute type. Those come only from the spec, so changing one means uploading a new version, which gets a new digest and a new review.
- **Provenance is recorded.** Each value keeps its source (Spec, README, Dockerfile, Generated or Edited). Reviewers see it, and a link you typed yourself is highlighted, because an edited link is what a phishing change would look like.
- **Live card preview.** The new-listing form shows the card exactly as the directory will render it.
- **New versions offer a listing update.** When a new version's detected metadata differs from the live listing, the form offers a listing update with only the changed fields: **Accept**, **Keep current** or **Edit** each one. Nothing reaches the listing unless you submit it.

## How requests are decided

- **Review.** Managers see each request against your previous approved version: metadata with provenance, contract changes (secrets, egress hosts, required inputs, environment keys, commands, running as root), the vulnerability delta, the Dockerfile, the SBOM package delta, the icon and your history as a publisher.
- **Two people** approve every Official request, Verified applications and moderation actions such as lifting a suspension. One person can't give both approvals.
- **No self-dealing.** A manager who belongs to your organization can't decide your request.
- **Auto-approval rules.** The system org can auto-approve low-risk requests. Two rules are seeded:
  - *Verified updates*: a patch or minor version of an existing listing from a Verified publisher, or a text-only listing update;
  - *Official catalog*: the same for the Official catalog, only when submitted by the catalog loader, capped at one version per listing and 50 versions a day, and switchable off with `OFFICIAL_AUTO_APPROVAL_ENABLED`.

  A rule never approves a major or `breaking` version, a new listing, a version with new critical or high vulnerabilities, or one that adds secrets, egress hosts, required inputs or root.
- **Security-fix lane.** A version or yank request linked to a security advisory on the listing goes to a priority lane with a 4-hour target, and managers are told at once. It stays open even when you're over your listings limit.
- **Approval** copies the pinned image into the read-only `public/<publisher>/<name>` namespace, signs it fresh with your tier, records the version on the listing and makes it immutable.

You're told about every decision in-app and by email (notice N25; N7 for a Verified application; N9 and N10 for transfers).

## Pausing

Pause a listing or one version from the Publisher page's **Listings** tab. It takes effect at once and needs no review.

- A **paused listing** accepts no new installs. Existing installs keep resolving.
- A **paused version** is hidden and skipped when a new install resolves a version range. Installs already on it keep it.

Unpausing is a request, decided by the system org.

## Reviews of your listings

Signed-in users rate and review your listings on their public pages. Nobody in your organization, or a team under it, can review your listings or vote on their reviews.

- **Replies.** Holders of `publishers:manage` in your organization can post one public reply per review from the listing's **Reviews** tab (`PUT /api/plugins/reviews/:id/reply` with `{ body }`), edit it, or delete it (`DELETE` on the same path). Replies are Markdown, rendered on the server like reviews, up to 5,000 characters. The reviewer is told (N16). Moderators can remove a reply.
- **New reviews.** Your managers get notice N15 in-app, with the email batched hourly per listing (opt-out `ecosystem.reviews.email`). You see the reviewer's display name only, never their organization.
- **Reports.** Anyone signed in can report a review. Reports are handled by the platform's moderators, not by you. A report marked **security** is never posted: the review is hidden, your managers and the moderators are told at once and privately (N19), and a private advisory draft is opened for you and the moderators. Treat it like any security report: reproduce it, fix it, and ship the fix through the security-fix lane.
- **Your score** is a Bayesian average where reviews from organizations that ran your plugin count fully and others count half. See [Plugin Installing](plugin-installing.md#reviews-and-ratings).

Review and reply actions are audited with `affectedOrgId` = your organization: `plugin.review.*` and `plugin.review.reply.*`.

## Submitting without an account

Anyone can submit a plugin from the public directory, without signing in: **Submit a plugin** at `/plugins/submit`. It's meant for people who want to share one plugin and don't need a publisher of their own. If you have an account, publish from your organization's Publisher page instead.

The instance must turn it on: `ANONYMOUS_SUBMISSIONS_ENABLED=true`, **and** outbound email must be configured. Otherwise the page says submissions aren't enabled, and the API answers `404 SUBMISSIONS_DISABLED`.

### How it works

1. **Choose the package.** The same `.zip` an in-app upload takes (`plugin-spec.yaml`, a Dockerfile, and optionally a `README.md`), up to 50 MB. Zips with symbolic links, hard links or device files are refused.
2. **Check the details.** The package is read without being stored. Every catalog field is shown with the value detected from it and where that value came from, and you **accept** or **edit** each one, exactly as in [Catalog metadata: accept or edit](#catalog-metadata-accept-or-edit). You also see a preview of the directory card, the Dockerfile and spec lint results, and a scan for suspicious patterns. Execution settings (commands, env, secrets, egress, the smoke test) come only from the spec and can't be edited. A community listing can't use a curated vendor icon, so its card shows a monogram.
3. **Confirm and submit.** Give an email address and accept the submission terms: you confirm you have the right to publish the code under its license, and that it may be listed publicly. Submitting stores the package in a quarantine bucket. Nothing is built yet.
4. **Confirm your email.** The confirmation link expires in 30 minutes and works once. It opens a page with a **Confirm submission** button. The link never confirms on its own, so mail scanners that open links can't use it up. Unconfirmed submissions are deleted after 30 days.
5. **Automated checks.** The plugin is built in an isolated sandbox: a separate build service with no credentials, no cloud identity and network access only to package mirrors. Every check must pass:
   - the spec and execution contract are valid;
   - the license is an allowed SPDX identifier;
   - the Dockerfile and spec have no lint errors;
   - the image doesn't run as root;
   - the image's **fixable** critical findings are under the instance's threshold;
   - no high-severity suspicious patterns (crypto-miners, obfuscated shell, reading cloud or CI credentials, piping downloads to a shell);
   - no secret-looking default values in `env`;
   - a `smokeTest` is declared and passes (it runs with no network);
   - the name is allowed (see below).

   If any check fails, you're emailed the failed checks and nothing is listed.
6. **Moderation.** A submission that passes every check enters the Ecosystem console's queue as a **Community submission**. Two Ecosystem Managers must approve it. They see the check results, every suspicious-pattern finding (including lower-severity ones you aren't shown), the SBOM, the scan report, and the difference from the previous approved version. The target is two business days.
7. **The decision.** You're emailed either way. An approved plugin is published to `public/community/<name>`, signed fresh with the **Unverified** tier, and listed at `/plugins/community/<name>`. A rejection email carries the moderator's reason.

After confirming, you get a **status link** (`/plugins/submit/status?token=…`), shown once and repeated in every email. It shows the status, each check's result and the decision reason, and links the listing once approved. Bookmark it: anyone with the link can see the status, but not your email address.

### Names and updates

- Submissions are listed under the platform's `community` publisher, as `community/<name>`, where `<name>` is the spec's `name`.
- A name is refused when it's reserved, when an Official or Verified publisher already lists it, or when it's **confusable** with one of the 100 most-installed plugins: the same after lower-casing, dropping `-`, `_` and `.`, and reading look-alikes (`0`→`o`, `1`→`l`, `3`→`e`, `5`→`s`, `rn`→`m`, `vv`→`w`), or one edit away from one.
- **A new version** of a community plugin goes through the same flow. It's accepted only from the email address that submitted the approved listing. From any other address, it's refused with `409 NAME_TAKEN`.

### Claiming your listing

To manage the plugin from an account, create one with the **same email address**, create your publisher, and file a **claim** request for the community listing from the Publisher page. The system org decides it like a transfer. When your verified account email matches the address that submitted the listing, the moderators see that it matches. Otherwise they see "email does not match submitter" and approve only with a written justification. Once the claim is approved, the listing moves to your publisher, and you're notified.

### Limits and privacy

- **Proof of work instead of a captcha.** Before each upload, your browser solves a small puzzle (a few seconds of CPU; the page shows progress). No third-party captcha is used, so it also works on air-gapped instances.
- **3 submissions a day** per email address and per network address (rolling 24 hours). More are refused with `429 SUBMISSION_LIMIT`.
- **Your email address is never shown**, in the UI, the API or the audit log. It's stored hashed (to apply the limits and match claims) and encrypted (to send you the decision), and both are deleted 90 days after the decision.

### Submission API

The routes are public, under `/api/public/plugin-submissions`, and rate limited per network address. None of them accepts or needs a session.

| Method | Endpoint | Body | Result |
|--------|----------|------|--------|
| `GET` | `/challenge` | — | `{ challenge, difficulty, expiresAt }`: a single-use puzzle. Find a decimal `nonce` such that SHA-256(`<challenge>:<nonce>`) starts with at least `difficulty` zero bits. |
| `POST` | `/inspect` | multipart: `plugin` (zip), `pow` (`{"challenge","nonce"}` as JSON) | The spec summary, every detected catalog field with its source, lint results and a suspicious-pattern preview. Stores nothing. |
| `POST` | `/` | multipart: `plugin`, `email`, `pow`, `acceptTerms=true`, optional `metadata` (the edited catalog fields, as JSON) | `202 { id, status: "pending_verification" }`. Sends the confirmation email. |
| `POST` | `/verify` | JSON `{ token }` | `{ id, status, statusToken }` |
| `GET` | `/status?token=<statusToken>` | — | `{ id, name, version, status, reason?, gates?, listing? }` |

Statuses: `pending_verification`, `pending_review` (checks running or waiting for a moderator), `gate_failed`, `approved`, `rejected`, `expired`, `claimed`.

| Code | Status | Meaning |
|------|:------:|---------|
| `SUBMISSIONS_DISABLED` | 404 | Anonymous submissions are off on this instance, or outbound email isn't configured. |
| `PROOF_OF_WORK_INVALID` | 400 | The puzzle answer is missing, wrong, expired or already used. Get a new challenge. |
| `VALIDATION_ERROR` | 400 | The package, email, terms or an edited field is invalid. Editing an execution setting through `metadata` is refused here too. |
| `SUBMISSION_LIMIT` | 429 | 3 submissions in 24 hours from this email or network address. |
| `NAME_TAKEN` | 409 | The community listing was submitted from a different email address. |

## Why the ecosystem works this way

A plugin is not passive content. At pipeline runtime its image runs in the
**consuming** organization's CodeBuild project with that organization's declared
secrets, the pipeline's IAM role (often able to deploy to production) and its
checked-out source. A listed plugin is therefore a software-supply-chain
dependency, like an npm package or a GitHub Action, and the rules below all
follow from keeping "uploaded" and "trusted to run" separate.

**Governance.** Only the system organization decides what enters or changes the
ecosystem. Its **Ecosystem Manager** role (built in, system-org only, assigned by
superadmins, never grantable through custom roles) holds `plugins:moderate` and
`publishers:verify`, so managers don't need full superadmin. The permissions are
already separate, so splitting the role later is only a seed change. Tenant orgs
still decide what runs **in their own pipelines** (their consumption policy) —
that governs only their org, never the ecosystem. See the
[moderation runbook](runbooks/ecosystem-moderation.md) and
[Permissions](permissions.md).

**Decisions behind the rules:**

| Question | Answer, and why |
|---|---|
| Must anonymous submitters verify an email? | **Yes**, plus a self-hosted proof-of-work puzzle. The feature is unavailable without outbound email. |
| Anonymous reviews? | **No.** Anyone may read; writing needs a signed-in person. |
| May Unverified or Community plugins receive secrets? | **Not by default**; an org's consumption policy can allow it per tier. |
| Paid plugins or revenue share? | **Not offered**; the publisher model leaves room for it. |
| Is every listing and version decided by the system org, even from signed-in publishers? | **Yes.** To keep that sustainable, low-risk updates (patch/minor from Verified publishers, every gate green, no new secrets or egress) are approved by **auto-approval rules the system org owns** — audited, and revocable per rule. |
| Do installs count against the `plugins` quota? | **No**; installs are free. |
| Can a self-hosted instance install from the hosted directory? | **Not yet.** Each instance has its own directory; the listing format is designed so sync can be added without a schema change. |
| How do consumers pull another org's images? | Approval **copies** the pinned image into the read-only `public/<publisher>/<name>` namespace and signs it fresh there with the tier annotation. Copying — rather than widening token grants to publishers' namespaces — makes listed versions immutable, survives the publisher's deletion, and keeps the registry's token rules simple. `public/*` is pullable by every authenticated identity and writable only by image-registry. |
| How much does a review without verified use count? | **0.5**, labelled "not verified". |
| May members install directly? | Members hold `plugins:install`; whether that installs or files an approval request is the org's consumption policy (`requireApprovalToInstall`, on by default below Verified). |
| May a publisher pause without approval? | **Yes.** Pausing only narrows their own reach (hidden from new installs; existing installs keep resolving). Unpausing is a request. |
| Which plans may publish, install, or be Verified? | Installing, reviewing and every safety control are on **every** plan. Publishing is on every plan within a `listings` limit (3 / 10 / 25 / 100). **Verified** is open to Team and Enterprise only and is earned through review, never bought; there is no paid priority review. A downgrade keeps listings listed, freezes non-security updates while over the limit, and gives Verified a 30-day grace period. |
| Are Official plugins installed for every org? | **Yes, implicitly** — a virtual install (no rows) with policy `minor`; majors are never automatic. Orgs can install explicitly, opt out (`officialInstalls: explicit`) or block listings (`blockedListings`); an org's own same-name plugin still wins, with a shadowing warning. Explicit rows for everything would break existing pipelines, and seeding rows at org creation would miss Official plugins added later. See [Plugin Installing](plugin-installing.md#implicit-official-installs). |
| Where do listing logos come from? | Simple Icons (CC0) first, vendor press-kit marks only where the vendor's terms allow, monograms otherwise. Curated marks go only on Official listings and on Verified publishers who own the mark; Community listings upload raster icons or get a monogram. Free logo choice would enable impersonation, and SVG uploads would enable XSS. |
| Do routine Official catalog updates need two-person approval? | **No** — a seeded auto-approval rule covers gate-green patch/minor updates of existing Official listings submitted by the catalog loader service account, with no new secrets, egress, required inputs, root or vulnerabilities, capped at 1 per listing and 50 per day, and switchable off with `OFFICIAL_AUTO_APPROVAL_ENABLED`. New Official listings, majors and riskier updates keep two-person approval. |
| Where does catalog metadata come from, and who has the last word? | The package's own declarations are detected and pre-filled (spec, then README, then the plugin's own Dockerfile OCI labels — never labels inherited from its base image), and you **accept or edit** each field. Only descriptive fields are editable; execution-contract fields come from the spec alone, so changing one is a new version. Each field's source is shown to moderators. See [Catalog metadata](#catalog-metadata-accept-or-edit). |

**Versions are immutable once requested.** A version is frozen from the moment a
request references it: re-uploading it is refused (`PLUGIN_VERSION_FROZEN`), and
approval publishes the request's pinned digest, failing closed if the stored
digest differs. A yank stops a version resolving for new synths; pipelines pinned
by digest keep pulling it. A `public/*` image is garbage-collected only when it
was yanked more than 180 days ago **and** no deployed pipeline references it.

**Out of scope:** running plugins anywhere but CodeBuild, importing from other
ecosystems (GitHub Actions, npm), paid listings, and syncing between instances.

## Errors you may see

| Code | Meaning |
|------|---------|
| `PUBLISHER_REQUIRED` | Create your publisher profile first. |
| `PUBLISHER_TERMS_REQUIRED` | Accept the current publisher terms. |
| `PUBLISHER_ROOT_ORG_REQUIRED` | Switch to your root organization; teams can't publish. |
| `PUBLISHER_HANDLE_RESERVED` | The handle is reserved; submit a claim request if it's yours. |
| `PUBLISH_GATE_FAILED` | The version fails a check; `details.gates` lists which. |
| `QUOTA_EXCEEDED` (`details.quotaType: listings`) | You're at, or over, your plan's listings limit. |
| `PUBLISHER_SUSPENDED` | The system org suspended the publisher. |
| `PLUGIN_PUBLISHING_DISABLED` | Publishing is turned off on this instance (`PLUGIN_PUBLISHING_ENABLED`). |
| `PLUGIN_VERSION_FROZEN` | The version is referenced by a request or already listed. |
| `IMAGE_SCAN_UNAVAILABLE` | The build's image couldn't be scanned after every retry. Nothing was stored; build again later. |
| `PLUGIN_VULN_GATE` | The build's image has more fixable Critical findings than `PLUGIN_VULN_MAX_CRITICAL` allows. The message lists them with their fixed versions. |
| `DUPLICATE_ENTRY` | An open request of that kind already exists, or the handle is taken. |
