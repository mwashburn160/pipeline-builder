---
layout: default
title: Permission Contract
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Permission Contract

**This file is maintained BY HAND. There is no regenerate flag, and that is the point.**

## Highlights

- **A diff touching this file is a permission change.** Review it as a security change, whatever the commit message says.
- **There is deliberately no regenerate flag.** The hand edit is the reviewable artifact; a generated table would just agree with whatever the code now does.
- **The comparison covers the whole posture** — assurance level, step-up, entitlement, scope and internal-caller list — not only `permissions`.
- **Weakenings to watch for:** `sysadmin` becoming a permission, `all(...)` becoming `any(...)`, a dropped `aal2` / `step-up(...)` / `system-org`, a widened `internal(...)` list, or an added `+svc`.
- **Removing a row means the route is gone.** Adding one means a newly gated route — check it is gated at the *right* level, not merely gated.
- **The UI side is pinned separately** in `frontend/test/route-permissions.test.tsx`, and relaxing a gate here can leave the UI as the only thing still enforcing the old one.

## Overview

Every route's authorization is also recorded in `frontend/src/generated/route-table/<service>.json`, which is **generated** from the routes themselves. That makes permission *weakening* invisible: relax a gate and the generated table changes to match, so the diff looks like whatever the change intended. Nothing in review says "this route got easier to reach".

This file is the human-stated counterpart, and it exists for reviewers as much as for authors. If you are looking for what a permission *means* rather than which route demands it, see [Permissions](permissions.md).

## How it works

1. **Each service's route-coverage test generates its table** from the routes, and rewrites it on demand with `UPDATE_ROUTE_TABLES=1`.
2. **`frontend/test/permission-contract.test.ts` renders each generated route** into one canonical authorization string, using the tokens in [Notation](#notation) below.
3. **It parses every data row of this file** into the same shape.
4. **It fails on any disagreement** — a gated route missing from this file, a row for a route that no longer exists, or a row that states something different from what the route now enforces.
5. **The failure names the exact line to edit.** So a relaxed gate cannot land until someone states the new requirement here, by hand, in the same commit.

A further assertion checks that every notation token appearing in a row is explained above the table — a row whose rendering uses an unexplained token is unreviewable.

## Maintaining it

1. **Change the route's gate** in the service as usual.
2. **Regenerate that service's route table** (`UPDATE_ROUTE_TABLES=1` on its route-coverage test).
3. **Run the contract test.** It will fail and name the route plus what the route now requires.
4. **Edit the row here by hand** to state the new requirement. Copy the `routeRequires` string from the failure — it is already in canonical form.
5. **If you introduced a new token**, add it to the [Notation](#notation) table too, or the token assertion fails.
6. **Check the UI side.** Look at `KNOWN_UI_GATE_MISMATCHES` in `frontend/test/route-permissions.test.tsx`; if the control still checks the old gate, the dashboard is now stricter than the API.
7. **Say so in the commit message** when the change is a weakening, and expect a security review.

## Review rule

> A diff that touches this file is a permission change. Review it as a security
> change: for each altered row, ask what a caller can now reach that they could
> not before. `sysadmin` → a permission, `all(...)` → `any(...)`, a dropped
> `aal2`/`step-up(...)`/`system-org`, a widened `internal(...)` caller list, or an added
> `+svc` are all **weakenings**, whatever the commit message says.

Removing a row means the route is gone. Adding one means a newly gated route — check it is gated at the right level, not merely gated.

The **UI** side of the same question is pinned separately, in `frontend/test/route-permissions.test.tsx`: every write route here is either mapped to a dashboard control whose gate that suite proves by rendering it with and without the permission, or categorized there with the caller that drives it. Its `KNOWN_UI_GATE_MISMATCHES` list names the routes whose control checks a different gate from the row below — read it alongside this file when a row changes, because relaxing a gate here can leave the UI as the only thing still enforcing the old one.

## Area notes

These explain why particular families of rows look the way they do.

### Plugin ecosystem governance routes

Every `/plugins/ecosystem/*` row carries `system-org + ... + aal2`: only the system org decides anything in the plugin ecosystem, and only from an MFA-grade session (see [Plugin Publishing](plugin-publishing.md)). A row losing `system-org` or `aal2`, or gaining a tenant permission, is a governance weakening.

The request-decision rows (`/requests/:id/approve`, `/second-approve`, `/reject`) show no `step-up(...)` because the step-up is demanded per request KIND inside the chain — yank, transfer, claim, profile change, Verified application, moderation actions. Two-person approval and separation of duties are enforced by the service and pinned by `api/plugin/test/ecosystem-moderation.test.ts`.

The tenant `/plugins/publisher*` and `/plugins/publish-requests*` rows only submit requests or narrow the caller's own reach, which `api/plugin/test/ecosystem-governance.test.ts` enforces.

### Org-local install routes

The install rows (`/plugins/catalog`, `/plugins/listings/*/install-state`, `/plugins/installs*`, `/plugins/install-policy`, `/plugins/shadowing`) act only on the caller's own org.

`plugins:install` may install, upgrade and uninstall — but an install of an approval-required tier made without `plugin_installs:manage` only becomes a pending request, and moving such an install across a major or `breaking` version needs `plugin_installs:manage` too. Both are decided inside the service, so they don't show in the rows.

Loosening `PUT /plugins/install-policy` below `plugin_installs:manage + step-up(any)` lets any member widen what the org's pipelines may run, which is a weakening.

### Org toolchain default routes

The `/plugins/toolchain/org-default*` and `/plugins/toolchain/eligible` rows act only on the caller's own org; a team acts on the team, and none takes an org id. The writes are `toolchain:manage + step-up(any)` because an org default moves the managed toolchain of every unpinned pipeline in the org (and its teams without their own) on its next run ([plan D13](plans/bootstrap-image-versioning.md)). Loosening either write to `pipelines:write` (one pipeline's pin) or `plugin_installs:manage` (future installs) would let a member move every pipeline at once, which is a weakening; so is dropping the step-up. `toolchain:manage` confers nothing on the platform default, canary or catalog — the `POST /plugins/toolchain/initial-default` row and the Toolchain console stay out of its reach. Eligibility (D15) is decided inside the service, so it does not show in the rows.

The Toolchain console rows (`/plugins/toolchain/releases*`, `/history`, `/affected*`, `/cleanup`) are `system-org + any(toolchain:operate) + aal2`, and every write adds `step-up(any)` ([plan D9](plans/bootstrap-image-versioning.md)). They move or describe THE platform default and canary, which every org without its own default follows, so `toolchain:operate` is system-org-only and carried by Platform Operator. Dropping `system-org` would let a tenant token that somehow carried the permission reach them; replacing `toolchain:operate` with `toolchain:manage` (every tenant Admin) would hand every org the platform default; dropping `step-up` from a write, or adding one to a read, changes the §5 contract. Reads never step up.

### Plugin security notification routes

The `/plugins/pipelines/:pipelineId/*` rows act only on a pipeline of the caller's own org (any other answers 404). The triage `POST` records a pipeline's risk decision — a time-boxed acceptance (reason + expiry, KEV only with an explicit `kev: true`), a false positive, a reopen — which downgrades that pipeline's vulnerability warnings and notices for the accepted findings; loosening it below `pipelines:write` would let a read-only member silence a pipeline's security signal, which is a weakening. Vulnerability state never blocks a pipeline, so no row here gates one. `GET /internal/plugins/image-references` feeds the image registry's age GC the digests it must never delete; widening its caller list would leak which images an org's pipelines run.

The rows under `/plugins/security-notifications*` decide where the org's blocked-build (N30) and rescan (N31) notices go — including an outbound webhook and an external address. Loosening the `PUT` or the `test` send below `org_settings:write` would let any member redirect security notices or aim the webhook, which is a weakening.

The anonymous `POST /public/plugin-security-notifications/confirm` carries no caller identity — its single-use emailed token is the authority — so it has no row here. Its waiver is pinned in `api/plugin/test/route-coverage.test.ts`.

### Pipeline registry writes

`POST /pipelines/registry` and `DELETE /pipelines/registry/:id` are gated on `pipeline_registry:write`, a capability of their own, not on `pipelines:write`. The split lets the CodeBuild synth register its step manifest with the `pipeline-register` service account, which holds the **Pipeline Registration** Role and can do nothing else. People reach these routes through their Roles: the Member bundle (and so Admin and every template built on Member) carries `pipeline_registry:write` next to `pipelines:write`. There is deliberately no OR'd gate.

Before relaxing these rows, check two things. First, that no bundle quietly loses the capability. Second, that `pipeline_registry:write` never moves into the **Pipeline Automation** Role. The stored `platform` key holds that Role, and it reads only pipelines and plugins.

### Plugin reviews

The review writes (`/plugins/listings/*/reviews`, `/plugins/reviews/*`) are gated on `plugins:read` on purpose: every member who can browse the catalog may rate and review (see [Permissions](permissions.md)). The `aal1` is what makes them a PERSON's action — `requireAssurance({ minAssurance: 1 })` refuses service accounts and exchanged access keys with `HUMAN_SESSION_REQUIRED`. Dropping the `aal1` lets automation write, vote on and report reviews, which is a weakening.

Who may act on WHICH review is decided in the service and pinned by `api/plugin/test/ecosystem-reviews.test.ts`: the author edits and deletes; nobody from the publisher's own org reviews or votes; only the listing publisher's own managers reply.

The `/plugins/ecosystem/reviews*` moderation rows follow the governance rule above. Like the reserved names, they carry no step-up — hiding or restoring user content needs none.

### Deliberately read-gated writes

Two support surfaces depart from the usual shape on purpose; both are explained below.

One write is gated on a *read* permission on purpose: `message POST /messages/support`.

Contacting support is self-service — every member who can open the Messages page (`messages:read`) must be able to file a request, including a read-only one who holds no `messages:write`. The route is safe at that floor because it takes no recipient: the server forces every message to the support desk on the reserved `support` channel and discards any recipient the body carries. `POST /messages` stays on `messages:write`.

**Staff notes are gated on READ as hard as on write** (`message GET|POST|DELETE /messages/support/:id/notes`), which is the one place the "gate writes only" convention is deliberately broken. A note is the vendor's internal assessment of a customer and the single surface on a case the tenant must never see, so *reading* one is the sensitive act. The notes also live in their own table rather than as a flag on `messages`: that table is read through one shared visibility predicate, so a flag there would leak a note from any read path that forgot the extra condition, while a separate table has to be joined deliberately. The route gate is the second layer, not the only one.

**The canned-reply library is staff-gated on READ as well as write** (`message GET|POST|PATCH|DELETE /messages/support/canned`), the second place the "gate writes only" convention is deliberately broken. The templates are SYSTEM-WIDE — the vendor's own wording for recurring questions, authored once and reused across every customer — so the table carries no `org_id` and RLS does not apply to it. With no tenancy boundary underneath, the route gate is the only boundary there is.

**CSAT is the one case write STAFF may not make.** `message PATCH /messages/support/:id/satisfaction` runs on `messages:read` with the own-org check applied unconditionally — `staff: false` is passed with no admin variant — because a vendor-settable satisfaction score is not a satisfaction score. It is also the one write with no audit action, recorded as a waiver in `route-coverage.test.ts`: a 1-to-5 opinion on the customer's own case changes no entitlement, no ownership and no clock, so auditing it would only add noise to a trail read for authorization questions.

**The two support-incident internal routes are NAMED-CALLER gated to `message` alone.** Consuming an incident is a write that costs the customer something, so it must not be reachable by every service token in the fleet — the same reasoning as platform's `/internal/support/entitlement/:orgId`. The GRANT is system-org only and step-up gated: it hands a customer something of value, and it is the half whose absence made the whole mechanism pointless, since a concession nobody can grant is not a concession.

**`PUT /billing/admin/subscriptions/:id/support-floor` is system-org only** for the reason the floor exists: a negotiated price is a vendor decision, and a control a customer's own admin could reach would make the floor advisory rather than a floor.

**Case export stays on `messages:read`**, the same floor as the JSON list it reshapes — a deliberate departure from the `logs:export` precedent. That permission was split out of `observability:read` because reading logs in the UI is paged and ephemeral while exporting them is bulk egress that can carry secrets out of the building. Neither applies here: it is the org's OWN support metadata, already fully readable one route up, and reshaping readable data into a file is not a new disclosure. The export is METADATA ONLY — case numbers, status, and the target each case was opened against, never message bodies, because the conversation is a different and much larger thing to hand over.

**Support-contact designation is `org_settings:write`, read included** (`platform GET|POST|PATCH|DELETE /organization/:id/support-contacts`). It is an organization setting — which of the org's members speak for it to the support desk — rather than `billing:manage` (payment and plans) or `members:manage` (nothing here changes membership or a role). The READ carries the same capability because it discloses the account's **pooled** allowance and usage, a commercial fact spanning sibling teams the caller may not administer; the own-org list that ordinary members genuinely need is served separately by the message service on `messages:read`.

## Notation

| Token | Meaning |
|---|---|
| `any(a\|b)` | Caller holds **at least one** of these permissions |
| `all(a\|b)` | Caller holds **every** one of these permissions |
| `+svc` | A service principal also passes, without holding the permission |
| `sysadmin` | Platform administrator only (`isSuperAdmin`) |
| `dynamic(who…)` / `dynamic(who…:perm\|perm)` | Authorization the route resolves **per request**, so no static permission id can stand for it (`dynamicAuthz`). The prose rule lives on the route — a paragraph in a table cell stops being reviewable — but the PRINCIPAL KINDS it admits and the permission ids it consults are rendered here, so a rule that quietly starts admitting the superadmin flag, or stops consulting a permission, fails this test. Principal kinds are a closed set (api-core `DYNAMIC_PRINCIPALS`): `superadmin` (the `User.isSuperAdmin` flag), `system-org` (a system-org member holding a named permission), `tenant-admin` (admin/owner of the target's org or an ancestor — several of these rules refuse the flag on purpose), `tenant-member`, `subject` (the user the request is about), `service`, `gateway` (the ingress supplies the fact). Today: `/admin/console-check` (class from the gateway) and `/admin/console-session` (class stated by the caller, which is why it is `system-org`+`superadmin` and NOT `gateway`), plus the six impersonation routes |
| `system-org` | The caller's **active org** must be the system org (`requireSystemOrg`, the plugin-ecosystem governance boundary). Dropping it from a route gated on `plugins:moderate` / `publishers:verify` is a weakening — and fails api-core's `findSystemOrgGuardViolations` too |
| `service-principal` | Any signed service token |
| `internal(a,b)` | Peer services only, and only these callers — refuses every user token |
| `feature(f)` | Paid entitlement `f` required |
| `scope(s)` | Machine-credential scope `s` required. Next to a permission (`any(p) + scope(s)`) the gate admits EITHER credential — a member holding `p`, or a key carrying `s` (the org comes from the key). Today only `POST /pipelines/:id/security-reports`, which a scan step calls with the org's `reporting:ingest` key; dropping the scope there makes the route stricter, adding it anywhere else widens it |
| `aalN` | Authenticator assurance level ≥ N |
| `aalN(except c)` | …of every caller **except** the named carve-out `c`. Today the only one is `bootstrap-setup`: a fresh install's single administrator, who has no second factor to be MFA-grade with yet, on the setup calls `init-platform.sh` makes. Step-up still applies, the reach stays limited to the bootstrap allowlist, and a live re-read bounds it to `BOOTSTRAP_SETUP_WINDOW_MS` (default 24 h) after the install and to an exception that has not yet closed |
| `step-up(m,…)` | Recent re-authentication with one of these methods |
| `org-admin-assurance` | The org's "administrative actions require MFA" policy applies |
| `authenticated` | Signed in, nothing more |

| Service | Method | Path | Required authorization |
|---|---|---|---|
| ask | POST | `/ask` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| ask | POST | `/ask/agent/stream` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| ask | GET | `/ask/availability` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| ask | POST | `/ask/feedback` | `any(pipelines:read|plugins:read|templates:read)` |
| ask | GET | `/ask/providers` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| ask | POST | `/ask/stream` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| billing | GET | `/billing/admin/campaigns` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/campaigns` | `system-org + any(billing:operate) + aal2` |
| billing | GET | `/billing/admin/campaigns/:id` | `system-org + any(billing:operate) + aal2` |
| billing | PUT | `/billing/admin/campaigns/:id` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/campaigns/:id/end` | `system-org + any(billing:operate) + aal2` |
| billing | GET | `/billing/admin/discounts` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/discounts` | `system-org + any(billing:operate) + aal2` |
| billing | DELETE | `/billing/admin/discounts/:id` | `system-org + any(billing:operate) + aal2` |
| billing | GET | `/billing/admin/discounts/:id` | `system-org + any(billing:operate) + aal2` |
| billing | PUT | `/billing/admin/discounts/:id` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/discounts/:id/apply` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/discounts/:id/preview` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/discounts/:id/token` | `system-org + any(billing:operate) + aal2` |
| billing | GET | `/billing/admin/events` | `system-org + any(subscriptions:read) + aal2` |
| billing | GET | `/billing/admin/promotions` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/promotions` | `system-org + any(billing:operate) + aal2` |
| billing | DELETE | `/billing/admin/promotions/:id` | `system-org + any(billing:operate) + aal2` |
| billing | GET | `/billing/admin/promotions/:id` | `system-org + any(billing:operate) + aal2` |
| billing | PUT | `/billing/admin/promotions/:id` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/promotions/:id/activate` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/promotions/:id/grant` | `system-org + any(billing:operate) + aal2` |
| billing | POST | `/billing/admin/promotions/:id/preview` | `system-org + any(billing:operate) + aal2` |
| billing | GET | `/billing/admin/promotions/:id/spend` | `system-org + any(billing:operate) + aal2` |
| billing | GET | `/billing/admin/subscriptions` | `system-org + any(subscriptions:read) + aal2` |
| billing | PUT | `/billing/admin/subscriptions/:id` | `system-org + any(subscriptions:manage) + aal2 + step-up(any)` |
| billing | GET | `/billing/admin/summary` | `system-org + any(subscriptions:read) + aal2` |
| billing | GET | `/billing/charges` | `any(billing:read)` |
| billing | GET | `/billing/admin/offers` | `system-org + any(subscriptions:read) + aal2` |
| billing | GET | `/billing/admin/offers/exclusions` | `system-org + any(subscriptions:read) + aal2` |
| billing | PUT | `/billing/admin/offers/exclusions/:orgId` | `system-org + any(subscriptions:manage) + aal2` |
| billing | DELETE | `/billing/admin/offers/exclusions/:orgId` | `system-org + any(subscriptions:manage) + aal2` |
| billing | POST | `/billing/admin/offers/trigger/:orgId` | `system-org + any(subscriptions:manage) + aal2` |
| billing | POST | `/billing/admin/offers/withdraw` | `system-org + any(subscriptions:manage) + aal2` |
| billing | GET | `/billing/offers` | `any(billing:read)` |
| billing | POST | `/billing/offers/:id/decline` | `any(billing:manage)` |
| billing | POST | `/billing/offers/:id/dismiss` | `any(billing:manage)` |
| billing | GET | `/billing/crossover` | `any(billing:read)` |
| billing | GET | `/billing/plan-preview` | `any(billing:read)` |
| billing | POST | `/billing/admin/orgs/:orgId/support-incidents` | `system-org + any(support_cases:write) + aal2 + step-up(any)` |
| billing | PUT | `/billing/admin/subscriptions/:id/support-floor` | `system-org + any(subscriptions:manage) + aal2 + step-up(any)` |
| billing | POST | `/billing/internal/support-incidents/:orgId/consume` | `service-principal + internal(message)` |
| billing | POST | `/billing/internal/support-incidents/:orgId/refund` | `service-principal + internal(message)` |
| billing | GET | `/billing/bundles` | `any(billing:read)` |
| billing | GET | `/billing/events` | `any(billing:read)` |
| billing | GET | `/billing/invoices` | `any(billing:read)` |
| billing | POST | `/billing/marketplace/claim` | `any(billing:manage) + org-admin-assurance` |
| billing | GET | `/billing/marketplace/entitlements` | `any(billing:read)` |
| billing | POST | `/billing/portal` | `any(billing:manage) + org-admin-assurance` |
| billing | GET | `/billing/subscriptions` | `any(billing:read)` |
| billing | POST | `/billing/subscriptions` | `any(billing:manage) + org-admin-assurance` |
| billing | PUT | `/billing/subscriptions/:id` | `any(billing:manage) + org-admin-assurance` |
| billing | POST | `/billing/subscriptions/:id/addons` | `any(billing:manage) + org-admin-assurance` |
| billing | DELETE | `/billing/subscriptions/:id/addons/:bundleId` | `any(billing:manage) + org-admin-assurance` |
| billing | POST | `/billing/subscriptions/:id/addons/preview` | `any(billing:read)` |
| billing | POST | `/billing/subscriptions/:id/addons/basket` | `any(billing:manage) + org-admin-assurance` |
| billing | POST | `/billing/subscriptions/:id/cancel` | `any(billing:manage) + step-up(any) + org-admin-assurance` |
| billing | POST | `/billing/subscriptions/:id/discounts` | `any(billing:manage) + org-admin-assurance` |
| billing | DELETE | `/billing/subscriptions/:id/discounts/:discountId` | `any(billing:manage) + org-admin-assurance` |
| billing | POST | `/billing/subscriptions/:id/discounts/preview` | `any(billing:read)` |
| billing | POST | `/billing/subscriptions/:id/reactivate` | `any(billing:manage) + org-admin-assurance` |
| billing | DELETE | `/billing/subscriptions/by-org/:orgId` | `system-org + any(subscriptions:manage) + aal2` |
| billing | GET | `/billing/subscriptions/by-org/:orgId/billable` | `system-org + any(subscriptions:read) + aal2` |
| billing | POST | `/billing/subscriptions/checkout` | `any(billing:manage) + org-admin-assurance` |
| billing | GET | `/billing/summary` | `any(billing:read)` |
| billing | GET | `/billing/summary/allocation` | `any(billing:read)` |
| billing | GET | `/billing/summary/usage-by-team` | `any(billing:read) + feature(team_usage_analytics)` |
| billing | GET | `/billing/usage` | `any(billing:read)` |
| compliance | GET | `/compliance/audit` | `any(compliance:read)` |
| compliance | GET | `/compliance/entitlements/:orgId` | `service-principal + internal(billing)` |
| compliance | PUT | `/compliance/entitlements/:orgId` | `service-principal + internal(billing)` |
| compliance | POST | `/compliance/events/entity` | `service-principal + internal(pipeline,plugin)` |
| compliance | GET | `/compliance/exemptions` | `any(compliance:read)` |
| compliance | POST | `/compliance/exemptions` | `any(compliance:read)` |
| compliance | DELETE | `/compliance/exemptions/:id` | `any(compliance:write)` |
| compliance | PUT | `/compliance/exemptions/:id/review` | `any(compliance:write)` |
| compliance | POST | `/compliance/exemptions/bulk` | `any(compliance:read)` |
| compliance | GET | `/compliance/notification-preferences` | `any(compliance:read)` |
| compliance | PUT | `/compliance/notification-preferences` | `any(compliance:write)` |
| compliance | GET | `/compliance/posture` | `service-principal + internal(reporting)` |
| compliance | GET | `/compliance/policies` | `any(compliance:read)` |
| compliance | POST | `/compliance/policies` | `any(compliance:write)` |
| compliance | DELETE | `/compliance/policies/:id` | `any(compliance:write)` |
| compliance | GET | `/compliance/policies/:id` | `any(compliance:read)` |
| compliance | PUT | `/compliance/policies/:id` | `any(compliance:write)` |
| compliance | POST | `/compliance/policies/:id/purge` | `any(compliance:write) + step-up(any)` |
| compliance | POST | `/compliance/policies/:id/restore` | `any(compliance:write) + step-up(any)` |
| compliance | GET | `/compliance/policies/deleted` | `any(compliance:read)` |
| compliance | GET | `/compliance/published-rules` | `any(compliance:read)` |
| compliance | GET | `/compliance/rules` | `any(compliance:read)` |
| compliance | POST | `/compliance/rules` | `any(compliance:write)` |
| compliance | DELETE | `/compliance/rules/:id` | `any(compliance:write)` |
| compliance | GET | `/compliance/rules/:id` | `any(compliance:read)` |
| compliance | PUT | `/compliance/rules/:id` | `any(compliance:write)` |
| compliance | GET | `/compliance/rules/:id/history` | `any(compliance:read)` |
| compliance | POST | `/compliance/rules/:id/purge` | `any(compliance:write) + step-up(any)` |
| compliance | POST | `/compliance/rules/:id/restore` | `any(compliance:write) + step-up(any)` |
| compliance | GET | `/compliance/rules/deleted` | `any(compliance:read)` |
| compliance | GET | `/compliance/scan-schedules` | `any(compliance:read)` |
| compliance | POST | `/compliance/scan-schedules` | `any(compliance:write)` |
| compliance | DELETE | `/compliance/scan-schedules/:id` | `any(compliance:write)` |
| compliance | PUT | `/compliance/scan-schedules/:id` | `any(compliance:write)` |
| compliance | PATCH | `/compliance/scan-schedules/:id/active` | `any(compliance:write)` |
| compliance | GET | `/compliance/scans` | `any(compliance:read)` |
| compliance | POST | `/compliance/scans` | `any(compliance:write)` |
| compliance | GET | `/compliance/scans/:id` | `any(compliance:read)` |
| compliance | POST | `/compliance/scans/:id/cancel` | `any(compliance:write)` |
| compliance | GET | `/compliance/subscriptions` | `any(compliance:read)` |
| compliance | POST | `/compliance/subscriptions` | `any(compliance:read)` |
| compliance | DELETE | `/compliance/subscriptions/:ruleId` | `any(compliance:write)` |
| compliance | PATCH | `/compliance/subscriptions/:ruleId` | `any(compliance:read)` |
| compliance | DELETE | `/compliance/subscriptions/:ruleId/pin` | `any(compliance:write)` |
| compliance | POST | `/compliance/subscriptions/:ruleId/pin` | `any(compliance:write)` |
| compliance | POST | `/compliance/subscriptions/auto-subscribe` | `service-principal + internal(platform)` |
| compliance | POST | `/compliance/subscriptions/bulk` | `any(compliance:read)` |
| compliance | POST | `/compliance/subscriptions/clone` | `any(compliance:write)` |
| compliance | GET | `/compliance/subscriptions/enforced` | `any(compliance:read)` |
| compliance | POST | `/compliance/subscriptions/preview` | `any(compliance:read)` |
| compliance | POST | `/compliance/subscriptions/preview/impact` | `any(compliance:read)` |
| compliance | GET | `/compliance/templates` | `any(compliance:read)` |
| compliance | POST | `/compliance/templates/apply` | `any(compliance:write)` |
| compliance | POST | `/compliance/validate/pipeline` | `any(compliance:read)+svc` |
| compliance | POST | `/compliance/validate/pipeline/dry-run` | `any(compliance:read)+svc` |
| compliance | POST | `/compliance/validate/plugin` | `any(compliance:read)+svc` |
| compliance | POST | `/compliance/validate/plugin/dry-run` | `any(compliance:read)+svc` |
| image-registry | POST | `/api/admin/gc` | `any(registry:purge) + aal2` |
| image-registry | GET | `/api/admin/storage/:prefix` | `system-org + any(registry:read) + aal2` |
| image-registry | GET | `/api/images` | `system-org + any(registry:read) + aal2` |
| image-registry | DELETE | `/api/images/:name` | `any(registry:purge) + aal2` |
| image-registry | GET | `/api/images/:name/blobs/:digest` | `system-org + any(registry:read) + aal2` |
| image-registry | DELETE | `/api/images/:name/manifests/:reference` | `any(registry:purge) + aal2` |
| image-registry | GET | `/api/images/:name/manifests/:reference` | `system-org + any(registry:read) + aal2` |
| image-registry | GET | `/api/images/:name/tags` | `system-org + any(registry:read) + aal2` |
| image-registry | POST | `/api/images/copy` | `system-org + all(registry:read|registry:write) + aal2` |
| image-registry | POST | `/internal/plugin-signatures` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/plugin-images/discard` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/plugin-publications` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/plugin-publications/resign` | `service-principal + internal(plugin)` |
| image-registry | DELETE | `/internal/quarantine/:submissionId` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/quarantine/:submissionId/credential` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/plugin-publications/yank` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/plugin-publications/retag` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/plugin-publications/gc` | `service-principal + internal(plugin)` |
| image-registry | GET | `/internal/plugin-publications/verify` | `service-principal + internal(plugin)` |
| image-registry | POST | `/internal/plugin-publications/verify-cache/invalidate` | `service-principal + internal(plugin)` |
| image-registry | GET | `/internal/storage-usage/:orgId` | `service-principal + internal(quota)` |
| image-registry | GET | `/internal/storage-breakdown/:orgId` | `service-principal + internal(plugin)` |
| image-registry | DELETE | `/internal/storage-prune/:orgId` | `service-principal + internal(plugin)` |
| image-registry | DELETE | `/internal/org-namespace/:orgId` | `service-principal + internal(platform)` |
| message | GET | `/messages` | `any(messages:read)` |
| message | POST | `/messages` | `any(messages:write)` |
| message | DELETE | `/messages/:id` | `any(messages:write)` |
| message | POST | `/messages/delete` | `any(messages:write)` |
| message | GET | `/messages/:id` | `any(messages:read)` |
| message | PATCH | `/messages/:id` | `any(messages:write)` |
| message | GET | `/messages/:id/attachments` | `any(messages:read)` |
| message | POST | `/messages/:id/purge` | `any(messages:write) + step-up(any)` |
| message | POST | `/messages/hide` | `any(messages:read)` |
| message | POST | `/messages/unhide` | `any(messages:read)` |
| message | POST | `/messages/read` | `any(messages:read)` |
| message | PUT | `/messages/:id/read` | `any(messages:read)` |
| message | POST | `/messages/:id/reply` | `any(messages:write)` |
| message | POST | `/messages/:id/restore` | `any(messages:write) + step-up(any)` |
| message | GET | `/messages/:id/thread` | `any(messages:read)` |
| message | PUT | `/messages/:id/thread/read` | `any(messages:read)` |
| message | GET | `/messages/announcements` | `any(messages:read)` |
| message | POST | `/messages/attachments` | `any(messages:write)` |
| message | POST | `/messages/support/attachments` | `any(messages:read)` |
| message | GET | `/messages/support/cases` | `any(messages:read)` |
| message | POST | `/messages/support/:id/reply` | `any(messages:read)` |
| message | GET | `/messages/support/contacts` | `any(messages:read)` |
| message | GET | `/messages/support/queue` | `system-org + any(support_cases:write) + aal2` |
| message | PATCH | `/messages/support/:id/status` | `any(messages:read)` |
| message | PATCH | `/messages/support/:id/severity` | `system-org + any(support_cases:write) + aal2` |
| message | PATCH | `/messages/support/:id/assign` | `system-org + any(support_cases:write) + aal2` |
| message | PATCH | `/messages/support/:id/transfer` | `any(messages:read)` |
| message | GET | `/messages/support/cases/export` | `any(messages:read)` |
| message | PATCH | `/messages/support/:id/satisfaction` | `any(messages:read)` |
| message | PATCH | `/messages/support/bulk` | `system-org + any(support_cases:write) + aal2` |
| message | GET | `/messages/support/canned` | `system-org + any(support_content:write) + aal2` |
| message | POST | `/messages/support/canned` | `system-org + any(support_content:write) + aal2` |
| message | PATCH | `/messages/support/canned/:id` | `system-org + any(support_content:write) + aal2` |
| message | DELETE | `/messages/support/canned/:id` | `system-org + any(support_content:write) + aal2` |
| message | GET | `/messages/support/:id/notes` | `system-org + any(support_cases:write) + aal2` |
| message | POST | `/messages/support/:id/notes` | `system-org + any(support_cases:write) + aal2` |
| message | DELETE | `/messages/support/:id/notes/:noteId` | `system-org + any(support_cases:write) + aal2` |
| message | GET | `/messages/attachments/:id` | `any(messages:read)` |
| message | GET | `/messages/conversations` | `any(messages:read)` |
| message | GET | `/messages/deleted` | `any(messages:read)` |
| message | POST | `/messages/internal/notify` | `service-principal + internal(billing,compliance,platform,quota)` |
| message | GET | `/messages/internal/offers/frustration/:orgId` | `service-principal + internal(billing)` |
| message | DELETE | `/messages/internal/org/:orgId/attachments` | `service-principal + internal(platform)` |
| message | POST | `/messages/notifications/ticket` | `any(messages:read)` |
| message | GET | `/messages/recipients/orgs` | `any(messages:write)` |
| message | POST | `/messages/support` | `any(messages:read)` |
| message | GET | `/messages/unread/count` | `any(messages:read)` |
| pipeline | GET | `/pipeline-templates` | `any(templates:read)` |
| pipeline | POST | `/pipeline-templates` | `any(templates:write)` |
| pipeline | DELETE | `/pipeline-templates/:id` | `any(templates:write)` |
| pipeline | GET | `/pipeline-templates/:id` | `any(templates:read)` |
| pipeline | PUT | `/pipeline-templates/:id` | `any(templates:write)` |
| pipeline | POST | `/pipeline-templates/:id/instantiate` | `any(templates:read)` |
| pipeline | POST | `/pipeline-templates/:id/purge` | `any(templates:write) + step-up(any)` |
| pipeline | POST | `/pipeline-templates/:id/restore` | `any(templates:write) + step-up(any)` |
| pipeline | GET | `/pipeline-templates/deleted` | `any(templates:read)` |
| pipeline | GET | `/pipelines` | `any(pipelines:read)` |
| pipeline | POST | `/pipelines` | `any(pipelines:write)` |
| pipeline | DELETE | `/pipelines/:id` | `any(pipelines:write)` |
| pipeline | GET | `/pipelines/:id` | `any(pipelines:read)` |
| pipeline | PUT | `/pipelines/:id` | `any(pipelines:write)` |
| pipeline | POST | `/pipelines/:id/plugin-upgrades/preview` | `any(pipelines:read)` |
| pipeline | POST | `/pipelines/plugin-upgrades/apply` | `any(pipelines:write)` |
| pipeline | GET | `/pipelines/:id/security-reports` | `any(pipelines:read)` |
| pipeline | POST | `/pipelines/:id/security-reports` | `any(pipelines:write) + scope(reporting:ingest)` |
| pipeline | POST | `/pipelines/:id/purge` | `any(pipelines:write) + step-up(any)` |
| pipeline | POST | `/pipelines/:id/restore` | `any(pipelines:write) + step-up(any)` |
| pipeline | GET | `/pipelines/:id/scorecard` | `any(pipelines:read) + feature(advanced_reporting)` |
| pipeline | POST | `/pipelines/:pipelineId/executions` | `any(pipelines:write)` |
| pipeline | POST | `/pipelines/:pipelineId/executions/:executionId/stop` | `any(pipelines:write)` |
| pipeline | POST | `/pipelines/analyze/from-url` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/bulk/create` | `any(pipelines:write) + feature(bulk_operations)` |
| pipeline | POST | `/pipelines/bulk/delete` | `any(pipelines:write) + feature(bulk_operations)` |
| pipeline | PUT | `/pipelines/bulk/update` | `any(pipelines:write) + feature(bulk_operations)` |
| pipeline | GET | `/pipelines/deleted` | `any(pipelines:read)` |
| pipeline | GET | `/pipelines/find` | `any(pipelines:read)` |
| pipeline | POST | `/pipelines/generate` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/generate/from-url` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/generate/from-url/stream` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/generate/missing-plugins` | `any(plugins:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/generate/stream` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | GET | `/pipelines/providers` | `any(pipelines:read) + feature(ai_generation)` |
| pipeline | GET | `/pipelines/registry` | `any(pipelines:read)` |
| pipeline | POST | `/pipelines/registry` | `any(pipeline_registry:write)` |
| pipeline | DELETE | `/pipelines/registry/:id` | `any(pipeline_registry:write)` |
| pipeline | GET | `/pipelines/scorecard` | `any(pipelines:read) + feature(advanced_reporting)` |
| pipeline | POST | `/pipelines/validate` | `any(pipelines:write)` |
| platform | GET | `/admin/impersonate/requests` | `dynamic(subject,superadmin,tenant-admin,tenant-member:impersonation:approve)` |
| platform | POST | `/admin/impersonate/requests/:id/decide` | `dynamic(subject,superadmin,tenant-admin:impersonation:approve)` |
| platform | POST | `/admin/impersonate/requests/:id/redeem` | `dynamic(superadmin,system-org,tenant-admin:impersonation:open|team_access:open) + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/impersonate/requests/:id/revoke` | `dynamic(subject,superadmin,tenant-admin,tenant-member)` |
| platform | POST | `/admin/impersonate/:userId` | `dynamic(superadmin,system-org,tenant-admin:impersonation:open|team_access:open) + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/impersonate/:userId/breakglass` | `dynamic(superadmin) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/admin/org-idp` | `any(org_idp:write)` |
| platform | DELETE | `/admin/org-idp/:orgId` | `any(org_idp:write) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/admin/org-idp/:orgId` | `any(org_idp:write)` |
| platform | PATCH | `/admin/org-idp/:orgId` | `any(org_idp:write) + aal2 + step-up(totp,webauthn)` |
| platform | PUT | `/admin/org-idp/:orgId` | `any(org_idp:write) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/admin/orgs/:orgId/k8s-namespace.yaml` | `system-org + any(platform:read) + aal2 + step-up(any)` |
| platform | DELETE | `/admin/orgs/:orgId/kms-config` | `any(org_kms:write) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/admin/orgs/:orgId/kms-config` | `any(org_kms:write)` |
| platform | PUT | `/admin/orgs/:orgId/kms-config` | `any(org_kms:write) + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/orgs/:orgId/kms-config/test` | `any(org_kms:write)` |
| platform | GET | `/admin/console-check` | `system-org + dynamic(gateway,superadmin,system-org:database_console:open|objectstore_console:open|observability_console:open) + aal2` |
| platform | POST | `/admin/console-session` | `system-org + dynamic(superadmin,system-org:database_console:open|objectstore_console:open|observability_console:open) + aal2` |
| platform | GET | `/admin/summary` | `system-org + any(platform:read) + aal2` |
| platform | DELETE | `/admin/users/:id/grants` | `sysadmin + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/users/:id/grants` | `sysadmin + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/users/:id/mfa-reset` | `sysadmin + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/audit` | `any(audit:read)` |
| platform | POST | `/audit/events` | `service-principal + internal(ask,billing,compliance,image-registry,message,pipeline,plugin,quota,reporting)` |
| platform | GET | `/audit/verify` | `any(audit:read)` |
| platform | GET | `/dashboards` | `any(dashboards:read)` |
| platform | POST | `/dashboards` | `any(dashboards:write)` |
| platform | GET | `/dashboards/:id` | `any(dashboards:read)` |
| platform | POST | `/dashboards/:id/clone` | `any(dashboards:write)` |
| platform | GET | `/dashboards/deleted` | `any(dashboards:read)` |
| platform | GET | `/internal/ai/access/:orgId` | `service-principal + internal(ask,pipeline,plugin,reporting)` |
| platform | GET | `/internal/ai/keys/:orgId/:provider` | `service-principal + internal(ask,pipeline,plugin,reporting)` |
| platform | GET | `/internal/ecosystem/approvers` | `service-principal + internal(plugin)` |
| platform | GET | `/internal/ecosystem/publisher-eligibility/:orgId` | `service-principal + internal(plugin)` |
| platform | POST | `/internal/notify-email` | `service-principal + internal(billing,compliance,plugin,quota,reporting)` |
| platform | GET | `/internal/reporting/access-posture/:orgId` | `service-principal + internal(reporting)` |
| platform | GET | `/internal/offers/seat-activity/:orgId` | `service-principal + internal(billing)` |
| platform | GET | `/internal/reporting/recipient-check/:orgId` | `service-principal + internal(reporting)` |
| platform | GET | `/internal/reporting/report-authority/:orgId/:userId` | `service-principal + internal(reporting)` |
| platform | GET | `/internal/support/entitlement/:orgId` | `service-principal + internal(message)` |
| platform | GET | `/internal/notify-email/status` | `service-principal + internal(ask,plugin,reporting)` |
| platform | GET | `/invitation` | `any(invitations:manage)` |
| platform | DELETE | `/invitation/:invitationId` | `any(invitations:manage) + org-admin-assurance` |
| platform | POST | `/invitation/:invitationId/resend` | `any(invitations:manage) + org-admin-assurance` |
| platform | POST | `/invitation/send` | `any(invitations:manage) + org-admin-assurance` |
| platform | GET | `/observability/alert-destinations` | `any(observability:read)` |
| platform | POST | `/observability/alert-destinations` | `any(observability:write)` |
| platform | DELETE | `/observability/alert-destinations/:id` | `any(observability:write)` |
| platform | PUT | `/observability/alert-destinations/:id` | `any(observability:write)` |
| platform | POST | `/observability/alert-destinations/:id/purge` | `any(observability:write) + step-up(any)` |
| platform | POST | `/observability/alert-destinations/:id/restore` | `any(observability:write) + step-up(any)` |
| platform | POST | `/observability/alert-destinations/:id/test` | `any(observability:write)` |
| platform | GET | `/observability/alert-destinations/all` | `system-org + any(platform:read) + aal2` |
| platform | GET | `/observability/alert-destinations/deleted` | `any(observability:read)` |
| platform | GET | `/observability/alert-rules` | `any(observability:read)` |
| platform | POST | `/observability/alert-rules` | `any(observability:write)` |
| platform | DELETE | `/observability/alert-rules/:id` | `any(observability:write)` |
| platform | PUT | `/observability/alert-rules/:id` | `any(observability:write)` |
| platform | POST | `/observability/alert-rules/:id/purge` | `any(observability:write) + step-up(any)` |
| platform | POST | `/observability/alert-rules/:id/restore` | `any(observability:write) + step-up(any)` |
| platform | GET | `/observability/alert-rules/deleted` | `any(observability:read)` |
| platform | GET | `/observability/oncall-status` | `system-org + any(oncall:manage) + aal2` |
| platform | POST | `/observability/oncall-test` | `system-org + any(oncall:manage) + aal2` |
| platform | GET | `/observability/alert-rules/materialized.yml` | `system-org + any(platform:read) + aal2` |
| platform | GET | `/observability/alerts` | `any(observability:read)` |
| platform | GET | `/observability/catalog` | `any(observability:read)` |
| platform | GET | `/observability/logs` | `any(observability:read)` |
| platform | GET | `/observability/logs/context` | `any(observability:read)` |
| platform | GET | `/observability/logs/export` | `any(logs:export) + org-admin-assurance` |
| platform | GET | `/observability/logs/raw` | `any(observability:read)` |
| platform | GET | `/observability/logs/volume` | `any(observability:read)` |
| platform | POST | `/observability/query/batch` | `any(observability:read)` |
| platform | GET | `/observability/silences` | `any(observability:read)` |
| platform | POST | `/observability/silences` | `any(observability:write)` |
| platform | DELETE | `/observability/silences/:id` | `any(observability:write)` |
| platform | POST | `/organization` | `any(org_settings:write)` |
| platform | POST | `/organization/names` | `service-principal` |
| platform | DELETE | `/organization/:id` | `system-org + any(orgs:manage) + aal2 + step-up(any)` |
| platform | PUT | `/organization/:id` | `system-org + any(orgs:manage) + aal2 + step-up(any)` |
| platform | GET | `/organization/:id/authenticator-policy` | `any(org_settings:write)` |
| platform | PATCH | `/organization/:id/authenticator-policy` | `any(org_settings:write) + step-up(any)` |
| platform | GET | `/organization/:id/support-contacts` | `any(org_settings:write)` |
| platform | POST | `/organization/:id/support-contacts` | `any(org_settings:write)` |
| platform | PATCH | `/organization/:id/support-contacts/:userId` | `any(org_settings:write)` |
| platform | DELETE | `/organization/:id/support-contacts/:userId` | `any(org_settings:write)` |
| platform | GET | `/organization/:id/domains` | `any(org_settings:write)` |
| platform | POST | `/organization/:id/domains` | `any(org_settings:write)` |
| platform | DELETE | `/organization/:id/domains/:domainId` | `any(org_settings:write)` |
| platform | PATCH | `/organization/:id/domains/:domainId` | `any(org_settings:write)` |
| platform | POST | `/organization/:id/domains/:domainId/verify` | `any(org_settings:write)` |
| platform | GET | `/organization/:id/export` | `any(org_settings:write)` |
| platform | PATCH | `/organization/:id/identity` | `any(org_settings:write)` |
| platform | DELETE | `/organization/:id/idp` | `any(org_idp:write) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/organization/:id/idp` | `any(org_idp:write)` |
| platform | PATCH | `/organization/:id/idp` | `any(org_idp:write) + aal2 + step-up(totp,webauthn)` |
| platform | PUT | `/organization/:id/idp` | `any(org_idp:write) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/organization/:id/idp/group-mappings` | `any(roles:manage)` |
| platform | POST | `/organization/:id/idp/group-mappings` | `any(roles:manage) + org-admin-assurance` |
| platform | DELETE | `/organization/:id/idp/group-mappings/:mappingId` | `any(roles:manage) + org-admin-assurance` |
| platform | PUT | `/organization/:id/idp/group-mappings/:mappingId` | `any(roles:manage) + org-admin-assurance` |
| platform | POST | `/organization/:id/idp/metadata/import` | `any(org_idp:write)` |
| platform | GET | `/organization/:id/idp/sp-info` | `any(org_idp:write)` |
| platform | POST | `/organization/:id/idp/test` | `any(org_idp:write)` |
| platform | POST | `/organization/:id/idp/test/complete` | `any(org_idp:write)` |
| platform | GET | `/organization/:id/impersonation-policy` | `any(org_impersonation:write)` |
| platform | PATCH | `/organization/:id/impersonation-policy` | `any(org_impersonation:write) + step-up(any)` |
| platform | GET | `/organization/:id/join-requests` | `any(org_settings:write)` |
| platform | POST | `/organization/:id/join-requests/:reqId/:decision` | `any(org_settings:write)` |
| platform | POST | `/organization/:id/members` | `any(members:manage) + org-admin-assurance` |
| platform | DELETE | `/organization/:id/members/:userId` | `any(members:manage) + org-admin-assurance` |
| platform | PATCH | `/organization/:id/members/:userId/activate` | `any(members:manage) + org-admin-assurance` |
| platform | PATCH | `/organization/:id/members/:userId/deactivate` | `any(members:manage) + org-admin-assurance` |
| platform | POST | `/organization/:id/members/bulk-add` | `any(members:manage) + org-admin-assurance` |
| platform | GET | `/organization/:id/mfa-policy` | `any(org_settings:write)` |
| platform | PATCH | `/organization/:id/mfa-policy` | `any(org_settings:write) + step-up(any)` |
| platform | GET | `/organization/:id/mfa-resets` | `any(members:manage)` |
| platform | POST | `/organization/:id/mfa-resets` | `any(members:manage) + aal2 + step-up(any)` |
| platform | POST | `/organization/:id/mfa-resets/:requestId/approve` | `any(members:manage) + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/organization/:id/mfa-resets/:requestId/deny` | `any(members:manage)` |
| platform | POST | `/organization/:id/move` | `system-org + any(orgs:manage) + aal2 + step-up(any)` |
| platform | GET | `/organization/:id/password-policy` | `any(org_settings:write)` |
| platform | PATCH | `/organization/:id/password-policy` | `any(org_settings:write) + step-up(any)` |
| platform | POST | `/organization/:id/restore` | `any(org_settings:write) + step-up(any)` |
| platform | POST | `/organization/:id/roles` | `any(roles:manage) + org-admin-assurance` |
| platform | DELETE | `/organization/:id/roles/:roleId` | `any(roles:manage) + org-admin-assurance` |
| platform | PUT | `/organization/:id/roles/:roleId` | `any(roles:manage) + org-admin-assurance` |
| platform | POST | `/organization/:id/roles/:roleId/members` | `any(roles:manage) + org-admin-assurance` |
| platform | DELETE | `/organization/:id/roles/:roleId/members/:userId` | `any(roles:manage) + org-admin-assurance` |
| platform | GET | `/organization/:id/service-accounts` | `any(service_accounts:manage)` |
| platform | POST | `/organization/:id/service-accounts` | `any(service_accounts:manage) + aal2(except bootstrap-setup) + step-up(any)` |
| platform | DELETE | `/organization/:id/service-accounts/:accountId` | `any(service_accounts:manage) + step-up(any)` |
| platform | GET | `/organization/:id/service-accounts/:accountId` | `any(service_accounts:manage)` |
| platform | PATCH | `/organization/:id/service-accounts/:accountId` | `any(service_accounts:manage) + step-up(any)` |
| platform | POST | `/organization/:id/service-accounts/:accountId/keys` | `any(service_accounts:manage) + aal2(except bootstrap-setup) + step-up(any)` |
| platform | DELETE | `/organization/:id/service-accounts/:accountId/keys/:keyId` | `any(service_accounts:manage)` |
| platform | DELETE | `/organization/:id/teams/:teamId` | `any(org_settings:write) + step-up(any)` |
| platform | GET | `/organization/:id/teams/deleted` | `any(org_settings:write)` |
| platform | PATCH | `/organization/:id/tier` | `system-org + any(orgs:manage) + aal2 + step-up(any)` |
| platform | PATCH | `/organization/:id/transfer-owner` | `any(org_settings:write) + aal2 + step-up(any)` |
| platform | PUT | `/organization/ai-config` | `any(org_settings:write) + step-up(any)` |
| platform | GET | `/organizations` | `system-org + any(orgs:read) + aal2` |
| platform | GET | `/users` | `any(members:manage)` |
| platform | POST | `/users` | `any(members:manage)` |
| platform | DELETE | `/users/:id` | `any(members:manage) + aal2 + step-up(any)` |
| platform | GET | `/users/:id` | `any(members:manage)` |
| platform | PUT | `/users/:id` | `any(members:manage) + aal2 + step-up(any)` |
| platform | PUT | `/users/:id/features` | `any(members:manage) + aal2 + step-up(any)` |
| platform | POST | `/users/bulk-delete` | `any(members:manage) + aal2 + step-up(any)` |
| plugin | GET | `/internal/plugins/public-names` | `service-principal + internal(image-registry)` |
| plugin | GET | `/internal/plugins/image-references` | `service-principal + internal(image-registry)` |
| plugin | GET | `/plugins` | `any(plugins:read)` |
| plugin | GET | `/plugins/storage` | `any(plugins:read)` |
| plugin | POST | `/plugins/storage/prune` | `any(plugins:write)` |
| plugin | POST | `/plugins` | `any(plugins:write)` |
| plugin | DELETE | `/plugins/:id` | `any(plugins:write)` |
| plugin | GET | `/plugins/:id` | `any(plugins:read)` |
| plugin | GET | `/plugins/:id/sbom` | `any(plugins:read)` |
| plugin | GET | `/plugins/:id/findings` | `any(plugins:read)` |
| plugin | PUT | `/plugins/:id` | `any(plugins:write)` |
| plugin | POST | `/plugins/:id/deprecate` | `any(plugins:write)` |
| plugin | POST | `/plugins/:id/purge` | `any(plugins:write) + step-up(any)` |
| plugin | POST | `/plugins/:id/restore` | `any(plugins:write) + step-up(any)` |
| plugin | POST | `/plugins/:id/yank` | `any(plugins:write)` |
| plugin | POST | `/plugins/bulk/delete` | `any(plugins:write) + feature(bulk_operations)` |
| plugin | PUT | `/plugins/bulk/update` | `any(plugins:write) + feature(bulk_operations)` |
| plugin | GET | `/plugins/catalog` | `any(plugins:read)` |
| plugin | GET | `/plugins/deleted` | `any(plugins:read)` |
| plugin | POST | `/plugins/deploy-generated` | `any(plugins:write)` |
| plugin | GET | `/plugins/ecosystem/advisories` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/ecosystem/advisories` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | PATCH | `/plugins/ecosystem/advisories/:id` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/advisories/:id/withdraw` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/ecosystem/listings` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/ecosystem/listings/:id/state` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/listings/:id/versions/:version/deprecate` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/listings/:id/versions/:version/unyank` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/listings/:id/versions/:version/yank` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/ecosystem/overview` | `system-org + any(plugins:moderate|publishers:verify) + aal2` |
| plugin | GET | `/plugins/ecosystem/publishers` | `system-org + any(plugins:moderate|publishers:verify) + aal2` |
| plugin | POST | `/plugins/ecosystem/publishers/:id/suspend` | `system-org + any(publishers:verify) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/publishers/:id/tier` | `system-org + any(publishers:verify) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/publishers/:id/unsuspend` | `system-org + any(publishers:verify) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/ecosystem/requests` | `system-org + any(plugins:moderate|publishers:verify) + aal2` |
| plugin | GET | `/plugins/ecosystem/requests/:id` | `system-org + any(plugins:moderate|publishers:verify) + aal2` |
| plugin | GET | `/plugins/ecosystem/requests/:id/submission-sbom` | `system-org + any(plugins:moderate) + aal2` |
| plugin | GET | `/plugins/ecosystem/requests/:id/submission-scan` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/ecosystem/requests/:id/approve` | `system-org + any(plugins:moderate|publishers:verify) + aal2` |
| plugin | POST | `/plugins/ecosystem/requests/:id/reject` | `system-org + any(plugins:moderate|publishers:verify) + aal2` |
| plugin | POST | `/plugins/ecosystem/requests/:id/second-approve` | `system-org + any(plugins:moderate|publishers:verify) + aal2` |
| plugin | POST | `/plugins/ecosystem/resign` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/ecosystem/reviews` | `system-org + any(plugins:moderate) + aal2` |
| plugin | GET | `/plugins/ecosystem/flagged-versions` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/ecosystem/reviews/:id/hold` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/ecosystem/reviews/:id/release` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/ecosystem/reviews/:id/remove` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/reviews/:id/remove-reply` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/ecosystem/reserved-names` | `system-org + any(plugins:moderate) + aal2` |
| plugin | DELETE | `/plugins/ecosystem/reserved-names/:name` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | PUT | `/plugins/ecosystem/reserved-names/:name` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/ecosystem/rules` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/ecosystem/rules` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | DELETE | `/plugins/ecosystem/rules/:id` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | PATCH | `/plugins/ecosystem/rules/:id` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/ecosystem/rules/:id/approve-change` | `system-org + any(plugins:moderate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/publish-requests` | `any(plugins:read)` |
| plugin | POST | `/plugins/publish-requests` | `any(plugins:publish|publishers:manage)` |
| plugin | POST | `/plugins/publish-requests/:id/transfer-response` | `any(publishers:manage) + step-up(any)` |
| plugin | POST | `/plugins/publish-requests/:id/withdraw` | `any(plugins:publish|publishers:manage)` |
| plugin | GET | `/plugins/publish-requests/draft` | `any(plugins:publish)` |
| plugin | GET | `/plugins/publisher` | `any(plugins:read)` |
| plugin | PATCH | `/plugins/publisher` | `any(publishers:manage)` |
| plugin | POST | `/plugins/publisher` | `any(publishers:manage)` |
| plugin | GET | `/plugins/publisher/advisories` | `any(plugins:read)` |
| plugin | GET | `/plugins/publisher/incoming-transfers` | `any(publishers:manage)` |
| plugin | GET | `/plugins/publisher/insights` | `any(plugins:read)` |
| plugin | GET | `/plugins/publisher/listings` | `any(plugins:read)` |
| plugin | POST | `/plugins/publisher/listings/:listingId/deprecate` | `any(plugins:publish)` |
| plugin | POST | `/plugins/publisher/listings/:listingId/pause` | `any(plugins:publish)` |
| plugin | POST | `/plugins/publisher/terms` | `any(publishers:manage)` |
| plugin | GET | `/plugins/find` | `any(plugins:read)` |
| plugin | POST | `/plugins/generate` | `any(plugins:write) + feature(ai_generation)` |
| plugin | POST | `/plugins/generate/stream` | `any(plugins:write) + feature(ai_generation)` |
| plugin | POST | `/plugins/inspect` | `any(plugins:write)` |
| plugin | GET | `/plugins/install-policy` | `any(plugins:read)` |
| plugin | PUT | `/plugins/install-policy` | `any(plugin_installs:manage) + step-up(any)` |
| plugin | GET | `/plugins/installs` | `any(plugins:read)` |
| plugin | POST | `/plugins/installs` | `any(plugins:install)` |
| plugin | DELETE | `/plugins/installs/:id` | `any(plugins:install)` |
| plugin | PATCH | `/plugins/installs/:id` | `any(plugins:install)` |
| plugin | POST | `/plugins/installs/:id/approve` | `any(plugin_installs:manage)` |
| plugin | GET | `/plugins/installs/change-requests` | `any(plugin_installs:manage)` |
| plugin | POST | `/plugins/installs/:id/change-requests` | `any(plugins:install)` |
| plugin | POST | `/plugins/installs/:id/change-requests/approve` | `any(plugin_installs:manage)` |
| plugin | POST | `/plugins/installs/:id/change-requests/reject` | `any(plugin_installs:manage)` |
| plugin | POST | `/plugins/installs/:id/deny` | `any(plugin_installs:manage)` |
| plugin | GET | `/plugins/listings/:publisher/:name/install-state` | `any(plugins:read)` |
| plugin | GET | `/plugins/listings/:publisher/:name/review-state` | `any(plugins:read)` |
| plugin | POST | `/plugins/listings/:publisher/:name/reviews` | `any(plugins:read) + aal1` |
| plugin | DELETE | `/plugins/reviews/:id` | `any(plugins:read) + aal1` |
| plugin | PATCH | `/plugins/reviews/:id` | `any(plugins:read) + aal1` |
| plugin | DELETE | `/plugins/reviews/:id/helpful` | `any(plugins:read) + aal1` |
| plugin | PUT | `/plugins/reviews/:id/helpful` | `any(plugins:read) + aal1` |
| plugin | DELETE | `/plugins/reviews/:id/reply` | `any(publishers:manage) + aal1` |
| plugin | PUT | `/plugins/reviews/:id/reply` | `any(publishers:manage) + aal1` |
| plugin | POST | `/plugins/reviews/:id/report` | `any(plugins:read) + aal1` |
| plugin | POST | `/plugins/lookup` | `any(plugins:read)` |
| plugin | GET | `/plugins/pipelines/:pipelineId/security` | `any(pipelines:read)` |
| plugin | GET | `/plugins/pipelines/:pipelineId/exposures` | `any(pipelines:read)` |
| plugin | POST | `/plugins/pipelines/:pipelineId/exposures/:exposureId/triage` | `any(pipelines:write)` |
| plugin | POST | `/plugins/runtime-check` | `any(plugins:read)` |
| plugin | GET | `/plugins/kept-setup-images` | `system-org + any(plugins:moderate) + aal2` |
| plugin | POST | `/plugins/kept-setup-images/:id/promote` | `system-org + any(plugins:moderate) + aal2` |
| plugin | GET | `/plugins/plugin-usage` | `any(plugins:read)` |
| plugin | GET | `/plugins/providers` | `any(plugins:read) + feature(ai_generation)` |
| plugin | GET | `/plugins/security-notifications` | `any(plugins:read)` |
| plugin | PUT | `/plugins/security-notifications` | `any(org_settings:write)` |
| plugin | POST | `/plugins/security-notifications/test` | `any(org_settings:write)` |
| plugin | GET | `/plugins/shadowing` | `any(plugins:read)` |
| plugin | DELETE | `/plugins/queue/dlq` | `system-org + any(plugin_queue:manage) + aal2` |
| plugin | GET | `/plugins/queue/dlq` | `any(plugins:write)` |
| plugin | POST | `/plugins/queue/dlq/:jobId/replay` | `any(plugins:write)` |
| plugin | GET | `/plugins/queue/failed` | `any(plugins:write)` |
| plugin | POST | `/plugins/queue/failed/:jobId/retry` | `any(plugins:write)` |
| plugin | GET | `/plugins/queue/status` | `system-org + any(plugin_queue:manage) + aal2` |
| plugin | GET | `/plugins/queue/triage` | `any(plugins:write)` |
| plugin | POST | `/plugins/toolchain/initial-default` | `service-principal + internal(deploy-bootstrap)` |
| plugin | GET | `/plugins/toolchain/eligible` | `any(pipelines:read)` |
| plugin | GET | `/plugins/toolchain/org-default` | `any(pipelines:read)` |
| plugin | PUT | `/plugins/toolchain/org-default` | `any(toolchain:manage) + step-up(any)` |
| plugin | DELETE | `/plugins/toolchain/org-default` | `any(toolchain:manage) + step-up(any)` |
| plugin | GET | `/plugins/toolchain/org-default/history` | `any(pipelines:read)` |
| plugin | GET | `/plugins/toolchain/releases` | `system-org + any(toolchain:operate) + aal2` |
| plugin | GET | `/plugins/toolchain/releases/:v/adoption` | `system-org + any(toolchain:operate) + aal2` |
| plugin | GET | `/plugins/toolchain/releases/:v/canary` | `system-org + any(toolchain:operate) + aal2` |
| plugin | GET | `/plugins/toolchain/releases/:v/default-preview` | `system-org + any(toolchain:operate) + aal2` |
| plugin | PUT | `/plugins/toolchain/releases/:v/rollout` | `system-org + any(toolchain:operate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/toolchain/releases/:v/default` | `system-org + any(toolchain:operate) + aal2 + step-up(any)` |
| plugin | PATCH | `/plugins/toolchain/releases/:v` | `system-org + any(toolchain:operate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/toolchain/releases/:v/deprecate` | `system-org + any(toolchain:operate) + aal2 + step-up(any)` |
| plugin | POST | `/plugins/toolchain/releases/:v/yank` | `system-org + any(toolchain:operate) + aal2 + step-up(any)` |
| plugin | DELETE | `/plugins/toolchain/releases/:v` | `system-org + any(toolchain:operate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/toolchain/history` | `system-org + any(toolchain:operate) + aal2` |
| plugin | GET | `/plugins/toolchain/affected` | `system-org + any(toolchain:operate) + aal2` |
| plugin | POST | `/plugins/toolchain/affected/notify` | `system-org + any(toolchain:operate) + aal2 + step-up(any)` |
| plugin | GET | `/plugins/toolchain/cleanup` | `system-org + any(toolchain:operate) + aal2` |
| plugin | GET | `/plugins/vuln-waivers` | `any(plugins:read)` |
| plugin | GET | `/plugins/vulnerabilities/:advisoryId` | `any(plugins:read)` |
| plugin | GET | `/plugins/vulnerabilities/fleet` | `system-org + any(platform:read|plugins:moderate) + aal2` |
| quota | GET | `/quotas` | `any(quotas:read)` |
| quota | DELETE | `/quotas/:orgId` | `system-org + any(quotas:manage) + aal2 + step-up(any)` |
| quota | GET | `/quotas/:orgId` | `any(quotas:read)+svc` |
| quota | PUT | `/quotas/:orgId` | `system-org + any(quotas:manage) + aal2` |
| quota | GET | `/quotas/:orgId/:quotaType` | `any(quotas:read)+svc` |
| quota | GET | `/quotas/:orgId/at-risk` | `any(quotas:read)` |
| quota | POST | `/quotas/:orgId/decrement` | `service-principal + internal(ask,billing,compliance,image-registry,message,pipeline,platform,plugin,quota,reporting)` |
| quota | POST | `/quotas/:orgId/increment` | `service-principal + internal(ask,billing,compliance,image-registry,message,pipeline,platform,plugin,quota,reporting)` |
| quota | GET | `/quotas/:orgId/notice-settings` | `any(quotas:read)` |
| quota | PUT | `/quotas/:orgId/notice-settings` | `any(billing:manage)` |
| quota | GET | `/quotas/:orgId/own-usage` | `service-principal + internal(billing)` |
| quota | PUT | `/quotas/entitlement-sync/:orgId` | `service-principal + internal(billing)` |
| quota | GET | `/quotas/internal/:orgId/profile` | `service-principal + internal(billing)` |
| quota | POST | `/quotas/:orgId/reset` | `system-org + any(quotas:manage) + aal2 + step-up(any)` |
| quota | GET | `/quotas/:orgId/usage` | `any(quotas:read)` |
| quota | GET | `/quotas/all` | `system-org + any(orgs:read) + aal2` |
| quota | PUT | `/quotas/entitlement-sync/:orgId` | `service-principal + internal(billing)` |
| quota | GET | `/quotas/at-risk` | `system-org + any(orgs:read) + aal2` |
| reporting | POST | `/reports/deployments/:executionId/outcome` | `any(pipelines:write) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/action-failures` | `any(reports:read)` |
| reporting | GET | `/reports/execution/build-health` | `any(reports:read)` |
| reporting | GET | `/reports/execution/count` | `any(reports:read)` |
| reporting | GET | `/reports/execution/dora` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/dora/trend` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/duration` | `any(reports:read)` |
| reporting | GET | `/reports/execution/environments` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/errors` | `system-org + any(reports:read) + any(orgs:read) + aal2` |
| reporting | GET | `/reports/execution/list` | `any(reports:read)` |
| reporting | GET | `/reports/execution/stage-bottlenecks` | `any(reports:read)` |
| reporting | GET | `/reports/execution/stage-failures` | `any(reports:read)` |
| reporting | POST | `/reports/execution/stream/ticket` | `any(reports:read)` |
| reporting | GET | `/reports/execution/success-rate` | `any(reports:read)` |
| reporting | GET | `/reports/incidents` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | POST | `/reports/incidents/test` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/ingest-health` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/build-duration` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/build-failures` | `system-org + any(reports:read) + any(orgs:read) + aal2` |
| reporting | GET | `/reports/plugins/build-success-rate` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/distribution` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/runtime-duration` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/runtime-success-rate` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/summary` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/versions` | `any(reports:read)` |
| reporting | GET | `/reports/retention` | `any(reports:read)` |
| reporting | PUT | `/reports/retention-sync/:orgId` | `service-principal + internal(billing)` |
| reporting | PUT | `/reports/stakeholder-sync/:orgId` | `service-principal + internal(billing)` |
| reporting | GET | `/reports/retention-sync/:orgId` | `service-principal + internal(billing)` |
| reporting | GET | `/reports/settings/incidents` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | PUT | `/reports/settings/incidents` | `any(reports:read) + any(org_settings:write) + feature(advanced_reporting)` |
| reporting | POST | `/reports/stakeholder-internal/owner-left/:orgId/:userId` | `service-principal + internal(platform)` |
| reporting | GET | `/reports/stakeholder/definitions` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/definitions` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | DELETE | `/reports/stakeholder/definitions/:id` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder/definitions/:id` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | PUT | `/reports/stakeholder/definitions/:id` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder/definitions/:id/runs` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/definitions/:id/runs` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/definitions/:id/transfer` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | DELETE | `/reports/stakeholder/links/:id` | `any(reports:publish) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder/delivery-status` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder-preview` | `any(reports:read)` |
| reporting | POST | `/reports/stakeholder-preview` | `any(reports:write)` |
| reporting | GET | `/reports/stakeholder/policy` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | PUT | `/reports/stakeholder/policy` | `any(org_settings:write) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder/recipients` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/recipients` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | DELETE | `/reports/stakeholder/recipients/:id` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/recipients/:id/resend` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder/runs/:id` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder/runs/:id/links` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | GET | `/reports/stakeholder/runs/:id/pdf` | `any(reports:read) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/runs/:id/links` | `any(reports:publish) + feature(stakeholder_reports)` |
| reporting | PUT | `/reports/stakeholder/runs/:id/notes` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/runs/:id/summary` | `any(reports:write) + feature(stakeholder_reports)` |
| reporting | POST | `/reports/stakeholder/runs/:id/publish` | `any(reports:publish) + feature(stakeholder_reports)` |
