# Permission Contract

**This file is maintained BY HAND. There is no regenerate flag, and that is the point.**

Every route's authorization is also recorded in
`frontend/src/generated/route-table/<service>.json`, which is **generated** from
the routes themselves. That makes permission *weakening* invisible: relax a gate
and the generated table changes to match, so the diff looks like whatever the
change intended. Nothing in review says "this route got easier to reach".

This file is the human-stated counterpart. `frontend/test/permission-contract.test.ts`
compares the two and fails when they disagree — so relaxing a gate cannot land
until someone edits the line below **in the same commit**. That edit is the
reviewable artifact.

## Review rule

> A diff that touches this file is a permission change. Review it as a security
> change: for each altered row, ask what a caller can now reach that they could
> not before. `sysadmin` → a permission, `all(...)` → `any(...)`, a dropped
> `aal2`/`step-up(...)`, a widened `internal(...)` caller list, or an added
> `+svc` are all **weakenings**, whatever the commit message says.

Removing a row means the route is gone. Adding one means a newly gated route —
check it is gated at the right level, not merely gated.

The **UI** side of the same question is pinned separately, in
`frontend/test/route-permissions.test.tsx`: every write route here is either
mapped to a dashboard control whose gate that suite proves by rendering it with
and without the permission, or categorized there with the caller that drives it.
Its `KNOWN_UI_GATE_MISMATCHES` list names the routes whose control checks a
different gate from the row below — read it alongside this file when a row
changes, because relaxing a gate here can leave the UI as the only thing still
enforcing the old one.

## Deliberately read-gated writes

One write is gated on a *read* permission on purpose: `message POST
/messages/support`. Contacting support is self-service — every member who can
open the Messages page (`messages:read`) must be able to file a request,
including a read-only one who holds no `messages:write`. The route is safe at
that floor because it takes no recipient: the server forces every message to the
support desk on the reserved `support` channel and discards any recipient the
body carries. `POST /messages` stays on `messages:write`.

## Notation

| Token | Meaning |
|---|---|
| `any(a\|b)` | Caller holds **at least one** of these permissions |
| `all(a\|b)` | Caller holds **every** one of these permissions |
| `+svc` | A service principal also passes, without holding the permission |
| `sysadmin` | Platform administrator only (`isSuperAdmin`) |
| `service-principal` | Any signed service token |
| `internal(a,b)` | Peer services only, and only these callers — refuses every user token |
| `feature(f)` | Paid entitlement `f` required |
| `scope(s)` | Machine-credential scope `s` required |
| `aalN` | Authenticator assurance level ≥ N |
| `aalN(except c)` | …of every caller **except** the named carve-out `c`. Today the only one is `bootstrap-setup`: a fresh install's single administrator, who has no second factor to be MFA-grade with yet, on the setup calls `init-platform.sh` makes. Step-up still applies, the reach stays limited to the bootstrap allowlist, and a live re-read bounds it to `BOOTSTRAP_SETUP_WINDOW_MS` (default 24 h) after the install and to an exception that has not yet closed |
| `step-up(m,…)` | Recent re-authentication with one of these methods |
| `org-admin-assurance` | The org's "administrative actions require MFA" policy applies |
| `authenticated` | Signed in, nothing more |


| Service | Method | Path | Required authorization |
|---|---|---|---|
| ask | POST | `/ask` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| ask | POST | `/ask/agent/stream` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| ask | GET | `/ask/providers` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| ask | POST | `/ask/stream` | `any(pipelines:read|plugins:read|templates:read) + feature(ai_generation)` |
| billing | GET | `/billing/admin/discounts` | `sysadmin` |
| billing | POST | `/billing/admin/discounts` | `sysadmin` |
| billing | DELETE | `/billing/admin/discounts/:id` | `sysadmin` |
| billing | GET | `/billing/admin/discounts/:id` | `sysadmin` |
| billing | PUT | `/billing/admin/discounts/:id` | `sysadmin` |
| billing | POST | `/billing/admin/discounts/:id/apply` | `sysadmin` |
| billing | POST | `/billing/admin/discounts/:id/preview` | `sysadmin` |
| billing | POST | `/billing/admin/discounts/:id/token` | `sysadmin` |
| billing | GET | `/billing/admin/events` | `sysadmin` |
| billing | GET | `/billing/admin/promotions` | `sysadmin` |
| billing | POST | `/billing/admin/promotions` | `sysadmin` |
| billing | DELETE | `/billing/admin/promotions/:id` | `sysadmin` |
| billing | GET | `/billing/admin/promotions/:id` | `sysadmin` |
| billing | PUT | `/billing/admin/promotions/:id` | `sysadmin` |
| billing | POST | `/billing/admin/promotions/:id/activate` | `sysadmin` |
| billing | POST | `/billing/admin/promotions/:id/grant` | `sysadmin` |
| billing | POST | `/billing/admin/promotions/:id/preview` | `sysadmin` |
| billing | GET | `/billing/admin/promotions/:id/spend` | `sysadmin` |
| billing | GET | `/billing/admin/subscriptions` | `sysadmin` |
| billing | PUT | `/billing/admin/subscriptions/:id` | `sysadmin + step-up(any)` |
| billing | GET | `/billing/admin/summary` | `sysadmin` |
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
| billing | POST | `/billing/subscriptions/:id/cancel` | `any(billing:manage) + step-up(any) + org-admin-assurance` |
| billing | POST | `/billing/subscriptions/:id/discounts` | `any(billing:manage) + org-admin-assurance` |
| billing | DELETE | `/billing/subscriptions/:id/discounts/:discountId` | `any(billing:manage) + org-admin-assurance` |
| billing | POST | `/billing/subscriptions/:id/discounts/preview` | `any(billing:read)` |
| billing | POST | `/billing/subscriptions/:id/reactivate` | `any(billing:manage) + org-admin-assurance` |
| billing | DELETE | `/billing/subscriptions/by-org/:orgId` | `sysadmin` |
| billing | GET | `/billing/subscriptions/by-org/:orgId/billable` | `sysadmin` |
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
| image-registry | POST | `/api/admin/gc` | `any(registry:write)` |
| image-registry | GET | `/api/admin/storage/:prefix` | `any(registry:read)` |
| image-registry | GET | `/api/images` | `any(registry:read)` |
| image-registry | DELETE | `/api/images/:name` | `any(registry:write)` |
| image-registry | GET | `/api/images/:name/blobs/:digest` | `any(registry:read)` |
| image-registry | DELETE | `/api/images/:name/manifests/:reference` | `any(registry:write)` |
| image-registry | GET | `/api/images/:name/manifests/:reference` | `any(registry:read)` |
| image-registry | GET | `/api/images/:name/tags` | `any(registry:read)` |
| image-registry | POST | `/api/images/copy` | `all(registry:read|registry:write)` |
| image-registry | POST | `/internal/plugin-signatures` | `service-principal + internal(plugin)` |
| message | GET | `/messages` | `any(messages:read)` |
| message | POST | `/messages` | `any(messages:write)` |
| message | DELETE | `/messages/:id` | `any(messages:write)` |
| message | GET | `/messages/:id` | `any(messages:read)` |
| message | PATCH | `/messages/:id` | `any(messages:write)` |
| message | GET | `/messages/:id/attachments` | `any(messages:read)` |
| message | POST | `/messages/:id/purge` | `any(messages:write) + step-up(any)` |
| message | PUT | `/messages/:id/read` | `any(messages:read)` |
| message | POST | `/messages/:id/reply` | `any(messages:write)` |
| message | POST | `/messages/:id/restore` | `any(messages:write) + step-up(any)` |
| message | GET | `/messages/:id/thread` | `any(messages:read)` |
| message | PUT | `/messages/:id/thread/read` | `any(messages:read)` |
| message | GET | `/messages/announcements` | `any(messages:read)` |
| message | POST | `/messages/attachments` | `any(messages:write)` |
| message | GET | `/messages/attachments/:id` | `any(messages:read)` |
| message | GET | `/messages/conversations` | `any(messages:read)` |
| message | GET | `/messages/deleted` | `any(messages:read)` |
| message | POST | `/messages/internal/notify` | `service-principal + internal(platform)` |
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
| pipeline | POST | `/pipelines/:id/purge` | `any(pipelines:write) + step-up(any)` |
| pipeline | POST | `/pipelines/:id/restore` | `any(pipelines:write) + step-up(any)` |
| pipeline | GET | `/pipelines/:id/scorecard` | `any(pipelines:read) + feature(advanced_reporting)` |
| pipeline | POST | `/pipelines/:pipelineId/executions` | `any(pipelines:write)` |
| pipeline | POST | `/pipelines/:pipelineId/executions/:executionId/stop` | `any(pipelines:write)` |
| pipeline | POST | `/pipelines/bulk/create` | `any(pipelines:write) + feature(bulk_operations)` |
| pipeline | POST | `/pipelines/bulk/delete` | `any(pipelines:write) + feature(bulk_operations)` |
| pipeline | PUT | `/pipelines/bulk/update` | `any(pipelines:write) + feature(bulk_operations)` |
| pipeline | GET | `/pipelines/deleted` | `any(pipelines:read)` |
| pipeline | GET | `/pipelines/find` | `any(pipelines:read)` |
| pipeline | POST | `/pipelines/generate` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/generate/from-url` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/generate/from-url/stream` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | POST | `/pipelines/generate/stream` | `any(pipelines:write) + feature(ai_generation)` |
| pipeline | GET | `/pipelines/providers` | `any(pipelines:read) + feature(ai_generation)` |
| pipeline | GET | `/pipelines/registry` | `any(pipelines:read)` |
| pipeline | POST | `/pipelines/registry` | `any(pipelines:write)` |
| pipeline | DELETE | `/pipelines/registry/:id` | `any(pipelines:write)` |
| pipeline | GET | `/pipelines/scorecard` | `any(pipelines:read) + feature(advanced_reporting)` |
| platform | GET | `/admin/org-idp` | `any(org:idp)` |
| platform | DELETE | `/admin/org-idp/:orgId` | `any(org:idp) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/admin/org-idp/:orgId` | `any(org:idp)` |
| platform | PATCH | `/admin/org-idp/:orgId` | `any(org:idp) + aal2 + step-up(totp,webauthn)` |
| platform | PUT | `/admin/org-idp/:orgId` | `any(org:idp) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/admin/orgs/:orgId/k8s-namespace.yaml` | `sysadmin + step-up(any)` |
| platform | DELETE | `/admin/orgs/:orgId/kms-config` | `any(org:kms) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/admin/orgs/:orgId/kms-config` | `any(org:kms)` |
| platform | PUT | `/admin/orgs/:orgId/kms-config` | `any(org:kms) + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/orgs/:orgId/kms-config/test` | `any(org:kms)` |
| platform | GET | `/admin/summary` | `sysadmin` |
| platform | DELETE | `/admin/users/:id/grants` | `sysadmin + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/users/:id/grants` | `sysadmin + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/admin/users/:id/mfa-reset` | `sysadmin + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/audit/events` | `service-principal + internal(ask,billing,compliance,image-registry,message,pipeline,plugin,quota,reporting)` |
| platform | GET | `/audit/verify` | `sysadmin` |
| platform | GET | `/dashboards` | `any(dashboards:read)` |
| platform | POST | `/dashboards` | `any(dashboards:write)` |
| platform | GET | `/dashboards/:id` | `any(dashboards:read)` |
| platform | POST | `/dashboards/:id/clone` | `any(dashboards:write)` |
| platform | GET | `/dashboards/deleted` | `any(dashboards:read)` |
| platform | POST | `/internal/notify-email` | `service-principal + internal(compliance)` |
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
| platform | GET | `/observability/alert-destinations/all` | `sysadmin` |
| platform | GET | `/observability/alert-destinations/deleted` | `any(observability:read)` |
| platform | GET | `/observability/alert-rules` | `any(observability:read)` |
| platform | POST | `/observability/alert-rules` | `any(observability:write)` |
| platform | DELETE | `/observability/alert-rules/:id` | `any(observability:write)` |
| platform | PUT | `/observability/alert-rules/:id` | `any(observability:write)` |
| platform | POST | `/observability/alert-rules/:id/purge` | `any(observability:write) + step-up(any)` |
| platform | POST | `/observability/alert-rules/:id/restore` | `any(observability:write) + step-up(any)` |
| platform | GET | `/observability/alert-rules/deleted` | `any(observability:read)` |
| platform | GET | `/observability/alert-rules/materialized.yml` | `sysadmin` |
| platform | GET | `/observability/alerts` | `any(observability:read)` |
| platform | GET | `/observability/audit-query` | `any(observability:read)` |
| platform | GET | `/observability/catalog` | `any(observability:read)` |
| platform | GET | `/observability/logs` | `any(observability:read)` |
| platform | GET | `/observability/logs/context` | `any(observability:read)` |
| platform | GET | `/observability/logs/export` | `any(logs:export) + org-admin-assurance` |
| platform | GET | `/observability/logs/raw` | `any(observability:read)` |
| platform | GET | `/observability/logs/volume` | `any(observability:read)` |
| platform | GET | `/observability/query` | `any(observability:read)` |
| platform | GET | `/observability/silences` | `any(observability:read)` |
| platform | POST | `/observability/silences` | `any(observability:write)` |
| platform | DELETE | `/observability/silences/:id` | `any(observability:write)` |
| platform | POST | `/organization` | `any(org:settings)` |
| platform | POST | `/organization/names` | `service-principal` |
| platform | DELETE | `/organization/:id` | `sysadmin + step-up(any)` |
| platform | PUT | `/organization/:id` | `sysadmin + step-up(any)` |
| platform | GET | `/organization/:id/authenticator-policy` | `any(org:settings)` |
| platform | PATCH | `/organization/:id/authenticator-policy` | `any(org:settings) + step-up(any)` |
| platform | GET | `/organization/:id/domains` | `any(org:settings)` |
| platform | POST | `/organization/:id/domains` | `any(org:settings)` |
| platform | DELETE | `/organization/:id/domains/:domainId` | `any(org:settings)` |
| platform | PATCH | `/organization/:id/domains/:domainId` | `any(org:settings)` |
| platform | POST | `/organization/:id/domains/:domainId/verify` | `any(org:settings)` |
| platform | GET | `/organization/:id/export` | `any(org:settings)` |
| platform | PATCH | `/organization/:id/identity` | `any(org:settings)` |
| platform | DELETE | `/organization/:id/idp` | `any(org:idp) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/organization/:id/idp` | `any(org:idp)` |
| platform | PATCH | `/organization/:id/idp` | `any(org:idp) + aal2 + step-up(totp,webauthn)` |
| platform | PUT | `/organization/:id/idp` | `any(org:idp) + aal2 + step-up(totp,webauthn)` |
| platform | GET | `/organization/:id/idp/group-mappings` | `any(roles:manage)` |
| platform | POST | `/organization/:id/idp/group-mappings` | `any(roles:manage) + org-admin-assurance` |
| platform | DELETE | `/organization/:id/idp/group-mappings/:mappingId` | `any(roles:manage) + org-admin-assurance` |
| platform | PUT | `/organization/:id/idp/group-mappings/:mappingId` | `any(roles:manage) + org-admin-assurance` |
| platform | POST | `/organization/:id/idp/metadata/import` | `any(org:idp)` |
| platform | GET | `/organization/:id/idp/sp-info` | `any(org:idp)` |
| platform | POST | `/organization/:id/idp/test` | `any(org:idp)` |
| platform | POST | `/organization/:id/idp/test/complete` | `any(org:idp)` |
| platform | GET | `/organization/:id/impersonation-policy` | `any(org:impersonation)` |
| platform | PATCH | `/organization/:id/impersonation-policy` | `any(org:impersonation) + step-up(any)` |
| platform | GET | `/organization/:id/join-requests` | `any(org:settings)` |
| platform | POST | `/organization/:id/join-requests/:reqId/:decision` | `any(org:settings)` |
| platform | POST | `/organization/:id/members` | `any(members:manage) + org-admin-assurance` |
| platform | DELETE | `/organization/:id/members/:userId` | `any(members:manage) + org-admin-assurance` |
| platform | PATCH | `/organization/:id/members/:userId/activate` | `any(members:manage) + org-admin-assurance` |
| platform | PATCH | `/organization/:id/members/:userId/deactivate` | `any(members:manage) + org-admin-assurance` |
| platform | POST | `/organization/:id/members/bulk-add` | `any(members:manage) + org-admin-assurance` |
| platform | GET | `/organization/:id/mfa-policy` | `any(org:settings)` |
| platform | PATCH | `/organization/:id/mfa-policy` | `any(org:settings) + step-up(any)` |
| platform | GET | `/organization/:id/mfa-resets` | `any(members:manage)` |
| platform | POST | `/organization/:id/mfa-resets` | `any(members:manage) + aal2 + step-up(any)` |
| platform | POST | `/organization/:id/mfa-resets/:requestId/approve` | `any(members:manage) + aal2 + step-up(totp,webauthn)` |
| platform | POST | `/organization/:id/mfa-resets/:requestId/deny` | `any(members:manage)` |
| platform | POST | `/organization/:id/move` | `sysadmin + step-up(any)` |
| platform | GET | `/organization/:id/password-policy` | `any(org:settings)` |
| platform | PATCH | `/organization/:id/password-policy` | `any(org:settings) + step-up(any)` |
| platform | POST | `/organization/:id/restore` | `any(org:settings) + step-up(any)` |
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
| platform | DELETE | `/organization/:id/teams/:teamId` | `any(org:settings) + step-up(any)` |
| platform | GET | `/organization/:id/teams/deleted` | `any(org:settings)` |
| platform | PATCH | `/organization/:id/tier` | `sysadmin + step-up(any)` |
| platform | PATCH | `/organization/:id/transfer-owner` | `any(org:settings) + aal2 + step-up(any)` |
| platform | PUT | `/organization/ai-config` | `any(org:settings) + step-up(any)` |
| platform | GET | `/organizations` | `sysadmin` |
| platform | GET | `/users` | `any(members:manage)` |
| platform | POST | `/users` | `any(members:manage)` |
| platform | DELETE | `/users/:id` | `any(members:manage) + aal2 + step-up(any)` |
| platform | GET | `/users/:id` | `any(members:manage)` |
| platform | PUT | `/users/:id` | `any(members:manage) + aal2 + step-up(any)` |
| platform | PUT | `/users/:id/features` | `any(members:manage) + aal2 + step-up(any)` |
| platform | POST | `/users/bulk-delete` | `any(members:manage) + aal2 + step-up(any)` |
| plugin | GET | `/plugins` | `any(plugins:read)` |
| plugin | POST | `/plugins` | `any(plugins:write)` |
| plugin | DELETE | `/plugins/:id` | `any(plugins:write)` |
| plugin | GET | `/plugins/:id` | `any(plugins:read)` |
| plugin | GET | `/plugins/:id/sbom` | `any(plugins:read)` |
| plugin | PUT | `/plugins/:id` | `any(plugins:write)` |
| plugin | POST | `/plugins/:id/purge` | `any(plugins:write) + step-up(any)` |
| plugin | POST | `/plugins/:id/restore` | `any(plugins:write) + step-up(any)` |
| plugin | POST | `/plugins/bulk/delete` | `any(plugins:write) + feature(bulk_operations)` |
| plugin | PUT | `/plugins/bulk/update` | `any(plugins:write) + feature(bulk_operations)` |
| plugin | GET | `/plugins/deleted` | `any(plugins:read)` |
| plugin | POST | `/plugins/deploy-generated` | `any(plugins:write)` |
| plugin | GET | `/plugins/find` | `any(plugins:read)` |
| plugin | POST | `/plugins/generate` | `any(plugins:write) + feature(ai_generation)` |
| plugin | POST | `/plugins/generate/stream` | `any(plugins:write) + feature(ai_generation)` |
| plugin | POST | `/plugins/lookup` | `any(plugins:read)` |
| plugin | GET | `/plugins/plugin-usage` | `any(plugins:read)` |
| plugin | GET | `/plugins/providers` | `any(plugins:read) + feature(ai_generation)` |
| plugin | DELETE | `/plugins/queue/dlq` | `sysadmin` |
| plugin | GET | `/plugins/queue/dlq` | `any(plugins:write)` |
| plugin | POST | `/plugins/queue/dlq/:jobId/replay` | `any(plugins:write)` |
| plugin | GET | `/plugins/queue/failed` | `any(plugins:write)` |
| plugin | POST | `/plugins/queue/failed/:jobId/retry` | `any(plugins:write)` |
| plugin | GET | `/plugins/queue/status` | `sysadmin` |
| plugin | GET | `/plugins/queue/triage` | `any(plugins:write)` |
| quota | GET | `/quotas` | `any(quotas:read)` |
| quota | DELETE | `/quotas/:orgId` | `sysadmin + step-up(any)` |
| quota | GET | `/quotas/:orgId` | `any(quotas:read)+svc` |
| quota | PUT | `/quotas/:orgId` | `sysadmin` |
| quota | GET | `/quotas/:orgId/:quotaType` | `any(quotas:read)+svc` |
| quota | GET | `/quotas/:orgId/at-risk` | `any(quotas:read)` |
| quota | POST | `/quotas/:orgId/decrement` | `service-principal + internal(ask,billing,compliance,image-registry,message,pipeline,platform,plugin,quota,reporting)` |
| quota | POST | `/quotas/:orgId/increment` | `service-principal + internal(ask,billing,compliance,image-registry,message,pipeline,platform,plugin,quota,reporting)` |
| quota | POST | `/quotas/:orgId/reset` | `sysadmin + step-up(any)` |
| quota | GET | `/quotas/all` | `sysadmin` |
| quota | GET | `/quotas/at-risk` | `sysadmin` |
| reporting | POST | `/reports/deployments/:executionId/outcome` | `any(pipelines:write) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/action-failures` | `any(reports:read)` |
| reporting | GET | `/reports/execution/build-health` | `any(reports:read)` |
| reporting | GET | `/reports/execution/count` | `any(reports:read)` |
| reporting | GET | `/reports/execution/dora` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/dora/trend` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/duration` | `any(reports:read)` |
| reporting | GET | `/reports/execution/environments` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/execution/errors` | `any(reports:read)` |
| reporting | GET | `/reports/execution/list` | `any(reports:read)` |
| reporting | GET | `/reports/execution/stage-bottlenecks` | `any(reports:read)` |
| reporting | GET | `/reports/execution/stage-failures` | `any(reports:read)` |
| reporting | POST | `/reports/execution/stream/ticket` | `any(reports:read)` |
| reporting | GET | `/reports/execution/success-rate` | `any(reports:read)` |
| reporting | GET | `/reports/incidents` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | POST | `/reports/incidents/test` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | GET | `/reports/ingest-health` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/build-duration` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/build-failures` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/build-success-rate` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/distribution` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/summary` | `any(reports:read)` |
| reporting | GET | `/reports/plugins/versions` | `any(reports:read)` |
| reporting | GET | `/reports/retention` | `any(reports:read)` |
| reporting | PUT | `/reports/retention-sync/:orgId` | `service-principal + internal(billing)` |
| reporting | GET | `/reports/settings/incidents` | `any(reports:read) + feature(advanced_reporting)` |
| reporting | PUT | `/reports/settings/incidents` | `any(reports:read) + any(org:settings) + feature(advanced_reporting)` |
