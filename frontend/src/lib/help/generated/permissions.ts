// GENERATED FROM docs/permissions.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: c35fc3ae8fcc5a5a6d1d4bdcd767885321a61ef7d497e13998bf45ea64f28b14
// SPDX-License-Identifier: Apache-2.0
import { UserCog } from 'lucide-react';
import type { HelpTopic } from '../types';

export const permissionsTopic: HelpTopic = {
  "icon": UserCog,
  "id": "permissions",
  "title": "Roles & Permissions",
  "description": "Permission catalog, built-in Roles, enforcement, session invalidation",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "<!-- Copyright 2026 Pipeline Builder Contributors SPDX-License-Identifier: Apache-2.0 -->"
        },
        {
          "type": "text",
          "content": "Access control is permission-based and single-source: a user's effective permissions are the union of the Roles assigned to them."
        }
      ]
    },
    {
      "id": "highlights",
      "title": "Highlights",
      "blocks": [
        {
          "type": "list",
          "items": [
            "There is no hidden role-derived baseline. If a permission is not in one of your Roles, you do not have it.",
            "The owner / admin / member label on a membership grants nothing. It is for display and ownership transfer only.",
            "Custom Roles are bounded by their author's own permissions — a permission ceiling, so nobody can mint authority they lack.",
            "Super Admin is a global flag, not a per-org permission, and it short-circuits to everything.",
            "The system org staffs its jobs with Roles, not the flag. Support, subscriptions, the org lifecycle, quotas, the build queue and the operator consoles are each a permission a Super Admin can grant on its own. Three routes still need the flag: granting or revoking Super Admin itself, and the single-person MFA reset.",
            "A cross-tenant surface takes three things, not one: the permission, the system org as your active org, and an MFA-grade session. A repo-wide test fails any route that gates on a system-org-only permission without all three.",
            "Writes are gated; reads mostly ride the page. That convention is deliberate and is what the route-coverage tests check.",
            "A startup backfill keeps built-in Roles synced to the current catalog, so a new permission reaches the built-ins without a migration.",
            "Impersonation is consent-gated and read-only, and every session is recorded.",
            "Teams do not inherit member authority upward. A parent admin administers its teams; a team member gets nothing over the parent."
          ]
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This reference documents the per-org, permission-based access control model: the fine-grained resource:action catalog, the built-in and custom Roles that bundle those permissions, and how they are enforced."
        },
        {
          "type": "text",
          "content": "It is for admins managing Roles and for developers gating routes. Everything is scoped to an organization or team. The vendor's own cross-tenant work is not behind the Super Admin flag any more: it is a set of system-org-only permissions bundled into job Roles, so one job can be staffed without handing over all of them. Only three routes still require the flag, and they say why."
        },
        {
          "type": "list",
          "items": [
            "Source of truth: packages/api-core/src/types/permissions.ts",
            "Enforcement middleware: packages/api-core/src/middleware/auth.ts"
          ]
        },
        {
          "type": "text",
          "content": "Read The model first, then the permission catalog and enforcement."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "list",
          "items": [
            "A Role is a named set of resource:action permissions, stored in the roles and role_assignments collections.",
            "A user is assigned Roles within an organization.",
            "Their effective permission set is the deduplicated union of those Roles. A Super Admin short-circuits to all.",
            "A gate on the route checks it — one permission, all of a set, or a permission-or-service-principal — before the handler runs.",
            "A refused write is audited as authz.denied, so probing leaves a trail.",
            "Changing a Role takes effect on the next request, and the changes that must invalidate a session bump tokenVersion — see Session invalidation."
          ]
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Start from the built-in Roles. New orgs seed Admin and Member; the system org also gets Super Admin.",
            "Author custom Roles with roles:manage, remembering the ceiling: you cannot grant a permission you do not hold.",
            "Assign Roles to members rather than editing the membership label, which grants nothing.",
            "Gate new routes on a permission, and declare the audit action on it — the per-service route-coverage test fails an ungated or undeclared write.",
            "Record sensitive routes in the permission contract in the same commit, or the parity test fails.",
            "For teams, grant downward authority deliberately: see Teams."
          ]
        }
      ]
    },
    {
      "id": "the-model",
      "title": "The model",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Role — a named set of fine-grained resource:action permissions"
          ]
        },
        {
          "type": "text",
          "content": "(e.g. a \"Billing Manager\" role granting billing:read + billing:manage). Stored in the roles / role_assignments collections."
        },
        {
          "type": "list",
          "items": [
            "Effective permissions — resolveUserPermissions(assignedPermissions, isSuperAdmin)"
          ]
        },
        {
          "type": "text",
          "content": "returns the deduplicated union of every assigned Role's permissions. No Role assigned → no permissions (a Super Admin short-circuits to all)."
        },
        {
          "type": "list",
          "items": [
            "Built-in Roles — every org seeds Admin and Member; the system org"
          ]
        },
        {
          "type": "text",
          "content": "also seeds Super Admin and Ecosystem Manager (see Ecosystem Manager). A startup backfill re-syncs each built-in Role's permission set to the current catalog, so new permissions reach existing orgs."
        },
        {
          "type": "list",
          "items": [
            "Custom Roles — admins with roles:manage can author additional Roles from"
          ]
        },
        {
          "type": "text",
          "content": "the org-assignable catalog (see the carve-out below), bounded by a permission ceiling: an author may only grant permissions they themselves hold, so a roles:manage holder cannot mint a Role carrying capabilities they lack (a Super Admin bypasses the ceiling)."
        },
        {
          "type": "list",
          "items": [
            "Coarse label — the owner / admin / member label on a membership is"
          ]
        },
        {
          "type": "text",
          "content": "display and authority only (ownership transfer, seat accounting). It is derived, and it does not grant permissions — those come only from Roles."
        }
      ]
    },
    {
      "id": "the-visibility-ladder",
      "title": "The visibility ladder",
      "blocks": [
        {
          "type": "text",
          "content": "Every catalog entity — pipelines, plugins, templates, dashboards — shares ONE three-rung sharing model, stored as a visibility column:"
        },
        {
          "type": "table",
          "headers": [
            "Rung",
            "Who can see it",
            "Who can edit it"
          ],
          "rows": [
            [
              "private",
              "Only the author (createdBy) — a personal draft",
              "The author (plus super admins)"
            ],
            [
              "org",
              "Everyone in the owning org",
              "The resource's :write permission"
            ],
            [
              "public",
              "The org and its child teams; from the system org, every org",
              "The resource's :publish permission"
            ]
          ]
        },
        {
          "type": "text",
          "content": "public never crosses tenant boundaries on its own: it means \"beyond just me, within my org tree\". The only globally-visible content is what lives in the system org, which is a superadmin action."
        },
        {
          "type": "text",
          "content": "Create-time defaults differ per entity, deliberately — the ladder is identical, only the starting rung differs:"
        },
        {
          "type": "list",
          "items": [
            "pipelines / plugins default to org. They are team assets that deploy"
          ]
        },
        {
          "type": "text",
          "content": "shared infrastructure, so creating one must not hide it from the team. A personal draft is available, but opt-in."
        },
        {
          "type": "list",
          "items": [
            "templates default to private. Draft-first is the point: you iterate on a"
          ]
        },
        {
          "type": "text",
          "content": "golden-path starter before sharing it."
        },
        {
          "type": "text",
          "content": "Enforcement lives in exactly two places, so no entity can drift: AccessControlQueryBuilder.buildAccessControl builds the read predicate, and requireVisibilityWriteAccess gates the writes."
        },
        {
          "type": "note",
          "content": "Messages are not on the ladder. Their visibility is a bespoke sender/recipient/broadcast predicate plus per-user targeting, so they carry no visibility column at all."
        }
      ]
    },
    {
      "id": "permission-catalog",
      "title": "Permission catalog",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Category",
            "Permissions",
            "Notes"
          ],
          "rows": [
            [
              "Pipelines",
              "pipelines:read, pipelines:write, pipelines:publish",
              ":publish allows the public rung"
            ],
            [
              "Templates",
              "templates:read, templates:write, templates:publish",
              "Golden-path pipeline templates. Split out of pipelines:* so a platform team can curate starters without pipeline write access. :write covers the private and org rungs; :publish is required for public. Instantiating a template creates a pipeline, so that still needs pipelines:write."
            ],
            [
              "Plugins",
              "plugins:read, plugins:write, plugins:publish",
              ":publish allows the public rung, and submitting plugin-ecosystem publish requests for the org's public versions"
            ],
            [
              "Plugin ecosystem",
              "plugins:install, plugin_installs:manage, publishers:manage",
              "Plugin Installing. plugins:install (member/admin/owner): install, upgrade (change version or policy) or uninstall listings, and withdraw one's own request — it only requests an install when the org's policy requires approval for the listing's tier, and moving an approval-tier install across a major or breaking version also needs plugin_installs:manage. plugin_installs:manage (admin/owner): the org's consumption policy (PUT /plugins/install-policy, step-up; org.plugin-install-policy.update), approving and denying install requests within the org (Plugins → Approvals), and installing approval-tier listings directly; holders are the org approvers who receive install notices (Plugin Installing). publishers:manage (admin/owner): the org's publisher profile (claim a handle, accept terms, edit description/homepage) and submitting publisher-level requests — handle/name changes, transfers and their acceptance (step-up), claims, the Verified application; every decision belongs to the system org (Plugin Publishing). plugins:publish also submits new-listing, new-version, listing-update, yank and unpause requests and pauses the org's own listings. Reading the catalog, installs, policy and shadowing needs only plugins:read. Installing is free on every plan and no consumption control is plan-gated."
            ],
            [
              "Plugin ecosystem (system org only)",
              "plugins:moderate, publishers:verify",
              "System-org only — never grantable to a custom Role in any org; held only through the built-in Ecosystem Manager Role or as a Super Admin. See the carve-out below."
            ],
            [
              "Platform operations (system org only)",
              "platform:read, orgs:read, billing:operate",
              "System-org only, and in no tenant-grantable Role. platform:read reads the deploy's own configuration (the Platform settings page: RLS context mode, per-org KMS, the rendered alert rules). orgs:read is the customer roster — the all-organizations list and drilling into one org's rows. Those were one permission until the split: three of the four job Roles carried it for the roster alone and got the deploy's internals with it, which is the same mistake consoles:datastore made before it was split by blast radius. billing:operate runs the cross-tenant finance surfaces — discount tokens and promotion campaigns."
            ],
            [
              "Cross-tenant administration (system org only)",
              "subscriptions:read, subscriptions:manage, orgs:manage, quotas:manage, plugin_queue:manage",
              "System-org only. The vendor's own operational tasks, each one replacing a requireSystemAdmin gate so that one job can be staffed with a Role. subscriptions:* is the cross-tenant plan surface (read split from write because a read-only holder — someone reporting on plan mix — is a real job); orgs:manage renames, re-tiers, moves and deletes any organization; quotas:manage changes another org's limits while viewing them rides platform:read; plugin_queue:manage reads build-queue depth and purges the dead-letter queue. Carried by Platform Operator and Account Manager as described below."
            ],
            [
              "Operator consoles (system org only)",
              "observability_console:open, database_console:open, objectstore_console:open",
              "System-org only. One permission per console class, by blast radius: Grafana and Kiali; pgAdmin and mongo-express; the RustFS (S3) console. Only the first is in the Platform Operator Role — staffing an operator must not hand over a shell over every tenant's rows as a side effect, nor the object store that holds the signed audit chain heads. The gateway checks the matching permission plus system org plus an MFA-grade session on every request to a console. See Operator consoles."
            ],
            [
              "Support desk (system org only)",
              "support_cases:write, support_content:write",
              "System-org only. support_cases:write is the desk's own work — triage the cross-tenant queue, assign and re-prioritise, write internal notes, record an incident against a support contract. support_content:write authors the canned replies reused across every customer. Each gates its task's reads as well as its writes, against the usual convention, because these tables carry no org_id: there is no tenancy boundary underneath to fall back on. Carried by the Support Agent Role."
            ],
            [
              "On-call (system org only)",
              "oncall:manage",
              "System-org only, and in no built-in Role — so in practice Super Admin only. Reads the paging posture (GET /observability/oncall-status) and sends a test page (POST /observability/oncall-test, audited because it rings a phone). Not a schedule editor: the provider owns the rota, the escalation and the contact methods. Deliberately outside the Ecosystem Manager Role — paging is the vendor's own operational concern, and widening that Role to carry it would hand the pager to people hired to review plugins. See On-call Paging."
            ],
            [
              "Compliance",
              "compliance:read, compliance:write",
              ""
            ],
            [
              "Members & access",
              "members:manage, roles:manage, invitations:manage, service_accounts:manage",
              "service_accounts:manage covers org service accounts and their pb_sa_… keys — split out of members:manage because minting a durable machine credential is a different decision from managing the roster. It is also what gates issuing a SCIM provisioning key. invitations:manage is the full send/revoke/resend authority on its own — see Invitations"
            ],
            [
              "Observability",
              "dashboards:read, dashboards:write, observability:read, observability:write, logs:export",
              "logs:export is admin/owner by default — viewing logs rides observability:read, but DOWNLOADING them is bulk egress an org may withhold from members. See Logs."
            ],
            [
              "Insights",
              "reports:read, reports:rollup",
              ":rollup allows including descendant teams in reports"
            ],
            [
              "Messaging",
              "messages:read, messages:write",
              "messages:read also covers contacting support (POST /messages/support) — reaching support is self-service, and that route takes no recipient (the server always addresses the support desk). Sending to anyone else needs messages:write."
            ],
            [
              "Billing & quotas",
              "billing:read, billing:manage, quotas:read",
              ""
            ],
            [
              "Registry",
              "registry:read, registry:write, registry:purge",
              "Never grantable to a custom Role in any org. :read (browse) and :write (copy/promote) are system-org-only; :purge (delete an image or repository, run GC) is Super Admin only"
            ],
            [
              "Org settings",
              "org_settings:write",
              "General org settings + AI provider config; team lifecycle for a parent admin (delete a team, list and restore recently-deleted teams, export); the org's plugin security notifications (PUT /plugins/security-notifications — recipients, rescan digest, webhook URL/secret, external address; POST /plugins/security-notifications/test; audited plugin.security_notifications.update / .test). Reading those settings needs only plugins:read (secret and address never returned)"
            ],
            [
              "SSO / IdP",
              "org_idp:write",
              "Per-org SSO/IdP configuration, OIDC and SAML (protocol selector, connection, certificates, attribute mapping) — sensitive (controls login); split out of org_settings:write"
            ],
            [
              "KMS",
              "org_kms:write",
              "Customer-managed KMS key configuration — sensitive (controls encryption); split out of org_settings:write"
            ],
            [
              "Impersonation",
              "impersonation:approve, team_access:open, org_impersonation:write",
              "impersonation:approve answers a consent request on the org's behalf; team_access:open lets a parent org's admin view a member of one of its teams. Both are in the admin and owner bundles. impersonation:open (the vendor's cross-tenant session) is system-org-only and not listed in the picker. See Impersonation. org_impersonation:write is the POLICY — sensitive (controls who may view the org's data as one of its members); split out of org_settings:write so a role that manages general settings cannot also open the org to impersonation"
            ]
          ]
        },
        {
          "type": "text",
          "content": ":read permissions are enforced — everywhere. Withholding any :read from a custom Role blocks that read at the API, not just in the UI: every read route carries its :read gate, proven per service by the route-coverage test (see Route coverage). Built-in Admin and Member both include all reads, so only bespoke custom Roles that drop a read are affected. A Role that grants pipelines:write without pipelines:read can still write but no longer list — grant both."
        },
        {
          "type": "text",
          "content": "Registry carve-out — three rungs, by blast radius. No tenant Role may carry any of them (sanitizePermissions strips them), but they are not all equally restricted:"
        },
        {
          "type": "table",
          "headers": [
            "Permission",
            "What it does",
            "Who may hold it"
          ],
          "rows": [
            [
              "registry:read",
              "Browse repositories, tags, manifests, blobs, the storage rollup",
              "System-org-only. Platform Observer, Platform Operator, Registry Operator."
            ],
            [
              "registry:write",
              "Copy/promote a tag into another repository — additive: it creates a tag and makes nothing stop resolving",
              "System-org-only. Registry Operator."
            ],
            [
              "registry:purge",
              "Delete a manifest, prune a repository, run GC — no undo",
              "SUPERADMIN_ONLY_PERMISSIONS, in no bundle: a Super Admin via implicit-all."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Two things make the split real rather than cosmetic. First, deleting a manifest can remove an image a tenant's pipeline still resolves — including the digest-pinned plugin images the supply chain verifies against — which is a different kind of act from promoting a release, and should not ride the same permission. Second, a second, independent per-repo filter (canReadRepo / canWriteRepo) runs after every one of these gates, so a non-superadmin system-org holder reaches system/, library/ and public/* — this deployment's own base and plugin images — and no tenant's org-* repositories at all. Widening the permission did not widen the reach."
        },
        {
          "type": "text",
          "content": "All three destructive routes and the copy also demand an MFA-grade session (minAssurance: 2)."
        },
        {
          "type": "text",
          "content": "System-org-only carve-out. plugins:moderate, publishers:verify, platform:read, orgs:read, registry:read, registry:write, billing:operate, the three *_console:open ids, impersonation:open and oncall:manage are in SYSTEM_ORG_ONLY_PERMISSIONS (predicate isSystemOrgOnlyPermission), a second non-assignable class next to the Super-Admin-only registry:purge. oncall:manage differs from the rest in one way worth stating: it is in no built-in Role either, so Super Admins are its only holders. That is deliberate rather than an omission — paging is the vendor's own operational concern and has nothing to do with ecosystem moderation. Every other member of this class has at least one seeded carrier, and that is an asserted invariant (packages/api-core/test/permissions.test.ts): a permission no custom Role may carry and no bundle grants is Super-Admin-only in practice, which is the exact failure this class exists to avoid — it is how platform:read shipped, and it is why splitting registry:write out of the purge rung came with a Registry Operator Role rather than on its own."
        },
        {
          "type": "text",
          "content": "The ecosystem pair governs the plugin ecosystem, which only the system org may manage or approve (governance). They're in no member/admin/owner bundle and a custom Role requesting either is rejected with RL_PERMISSION_NOT_ASSIGNABLE in every org — the system org and a Super Admin author included. The only holders are Super Admins (implicit-all) and members of the system org's built-in Ecosystem Manager Role."
        },
        {
          "type": "text",
          "content": "The class is enforced in five places, each tested (platform/test/ecosystem-manager-isolation.test.ts walks every path a tenant could try — custom Role, assignment, invitation, IdP mapping, token):"
        },
        {
          "type": "list",
          "items": [
            "Authoring — sanitizePermissions refuses them in any custom Role.",
            "Assignment — only a Super Admin may assign or unassign a Role carrying"
          ]
        },
        {
          "type": "text",
          "content": "them, and only inside the system org (below)."
        },
        {
          "type": "list",
          "items": [
            "Invitation — an invitation may name Roles to grant on acceptance"
          ]
        },
        {
          "type": "text",
          "content": "(roleIds), so it is a grant path and partitionAssignableRoles applies the same rule: a Role carrying one of these is refused unless the actor is a Super Admin. It also refuses the Super Admin Role outright, for everyone — granting the flag goes through POST /admin/users/:id/grants behind a step-up earned by a second factor, and an invitation is a bearer token delivered by email."
        },
        {
          "type": "list",
          "items": [
            "Token issue — confinePermissionsToOrg drops them from the permissions"
          ]
        },
        {
          "type": "text",
          "content": "claim of every token whose active org is not the system org (user tokens, exchanged keys and service-account tokens alike) — even a Super Admin's implicit-all, and even if a hand-written Role document carried them there."
        },
        {
          "type": "list",
          "items": [
            "Routes — requireSystemOrgPermission(...) (below) requires the system"
          ]
        },
        {
          "type": "text",
          "content": "org as the caller's active org, the permission, and an MFA-grade session."
        },
        {
          "type": "text",
          "content": "Built-in Role bundles"
        },
        {
          "type": "list",
          "items": [
            "Member — the read + author baseline: pipelines:* (read/write),"
          ]
        },
        {
          "type": "text",
          "content": "templates:* (read/write), plugins:* (read/write), plugins:install, compliance:read, dashboards:read, observability:read, reports:read, messages:read/write, billing:read, quotas:read. No :publish, no management, no :rollup."
        },
        {
          "type": "list",
          "items": [
            "Admin / Owner — every org-assignable permission (the full catalog minus"
          ]
        },
        {
          "type": "text",
          "content": "Super-Admin-only registry:purge and the system-org-only class, registry browse/copy and the ecosystem pair included). Includes pipelines:publish, templates:publish, plugins:publish, reports:rollup, plugin_installs:manage and publishers:manage."
        },
        {
          "type": "list",
          "items": [
            "Ecosystem Manager (system org only) — ECOSYSTEM_MANAGER_PERMISSIONS:"
          ]
        },
        {
          "type": "text",
          "content": "plugins:read, plugins:moderate, publishers:verify, messages:read, observability:read. See below."
        },
        {
          "type": "list",
          "items": [
            "Super Admin — implicit-all, including registry:*, plugins:moderate and"
          ]
        },
        {
          "type": "text",
          "content": "publishers:verify."
        },
        {
          "type": "text",
          "content": "Role templates"
        },
        {
          "type": "text",
          "content": "Every org seeds only the two Roles it cannot work without — Member and Admin — because a built-in is system: true and therefore undeletable, and an org should not carry rows for jobs it does not have."
        },
        {
          "type": "text",
          "content": "The jobs themselves are templates: pick one in the Role editor (\"Start from a job\") and it fills in the name, the description and the permission selection. What you get is an ordinary custom Role your org owns — editable, deletable, and bounded by your own permissions like any other, since custom Roles are capped by their author's ceiling."
        },
        {
          "type": "table",
          "headers": [
            "Template",
            "What the job is"
          ],
          "rows": [
            [
              "Team Lead",
              "Authors and shares stakeholder reports for a team, without org-admin access. (This was a seeded Role until it became a template — the only built-in that was a job description rather than a structural requirement.)"
            ],
            [
              "Release Manager",
              "Decides what becomes shared beyond its author, and approves plugin installs."
            ],
            [
              "Security Officer",
              "Identity, encryption keys and the evidence trail — the surface an auditor asks about. Also answers impersonation requests (impersonation:approve): whoever owns the policy that decides whether consent is needed should be able to give or withhold it."
            ],
            [
              "People Manager",
              "The roster and its machine credentials, across the account's teams (team_access:open) — without the org's settings or its money."
            ],
            [
              "Billing Manager",
              "The subscription, seats and invoices."
            ],
            [
              "Access Approver",
              "Answers requests to view this organization's accounts, and reads the trail of what happened. Two permissions only — impersonation:approve + audit:read — for an org that wants that decision to rest with one named person rather than with every admin. Consenting without being able to check what the session then did is consent in name only."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Why templates exist at all. The seeded ladder is Member (15 permissions) then Admin (all 37), so promoting anyone past \"author and read\" used to mean either picking from the full catalog by hand or — the shortcut people actually took — granting Admin, which includes org_kms:write, org_idp:write, billing:manage and roles:manage."
        },
        {
          "type": "text",
          "content": "None of them grants roles:manage. It is the one permission that compounds: its holder can mint further Roles, up to their own ceiling. Acquiring it stays a conscious act rather than a side effect of picking the job that sounded closest."
        },
        {
          "type": "text",
          "content": "Ecosystem Manager (system org only)"
        },
        {
          "type": "text",
          "content": "The built-in Role for the people who run the plugin ecosystem (moderation runbook): deciding publish requests, publisher tiers and profile changes, transfers, yanks and advisories, and moderating anonymous submissions and reviews. They get no platform superadmin powers — one of two built-in Roles that carry system-org-only permissions without the flag, alongside Platform Operator."
        },
        {
          "type": "table",
          "headers": [
            "Property",
            "Value"
          ],
          "rows": [
            [
              "Exists in",
              "The system org only. Seeded by seedDefaultRoles next to Super Admin, Admin and Member when the system org is created; never seeded in a tenant org or team. The org creator is not added to it."
            ],
            [
              "Immutable",
              "system: true — it can't be renamed, edited or deleted (RL_SYSTEM_IMMUTABLE). The startup backfill re-syncs it to ECOSYSTEM_MANAGER_PERMISSIONS (it is marked seedBundle: 'ecosystem_manager', which is also what keeps it out of the Member-floor lookups it shares grantsRole: 'member' with)."
            ],
            [
              "grantsRole",
              "member — no admin rights over the system org, and it never sets User.isSuperAdmin."
            ],
            [
              "Permissions",
              "plugins:read, plugins:moderate, publishers:verify, messages:read (in-app notices), observability:read (the moderation-SLA dashboard). Nothing tenant-facing: no registry:*, no members:manage."
            ],
            [
              "Who can assign it",
              "Super Admins only. Assigning or unassigning any Role that carries a system-org-only permission is refused for everyone else — an admin or owner of the system org included — with RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN (403). Such a Role can only be held inside the system org (RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG, 400). The same ceiling applies to service-account Role sets, and an IdP group mapping can never grant it (IGM_FORBIDDEN_GRANT, like the Super Admin Role)."
            ],
            [
              "Audit",
              "Assignment and removal are org.role.member.add / org.role.member.remove with affectedOrgId = the system org and details.role = 'Ecosystem Manager'."
            ],
            [
              "Notifications",
              "Every Super Admin and the affected user get N23 (in-app + email, can't be turned off) when someone is added or removed. Holders are the Moderators recipients of the other ecosystem notices (notifications); with nobody in the role, Super Admins receive them."
            ],
            [
              "Console",
              "The admin console's Ecosystem section (Ecosystem Manager assignment for Super Admins; the publish queue and publisher verification as the workflows land) appears only while the active org is the system org and the user holds plugins:moderate or publishers:verify. Tenant users never see it — this is a governance boundary, so the nav hides it rather than locking it. A holder without an MFA-grade session sees an enrol prompt instead."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Platform Operator (system org only)"
        },
        {
          "type": "text",
          "content": "The built-in Role for the people who run the deployment rather than the ecosystem: reading the platform's own configuration and cross-tenant counts, operating the finance surfaces, holding the pager, and opening the observability consoles."
        },
        {
          "type": "text",
          "content": "It exists because the ladder had a gap. Every permission it carries is system-org-only, which no custom Role may carry in any org — so without a seeded bundle these had no grant path at all, and the only way to let somebody read the Platform settings page was to make them a full Super Admin, handing over impersonation and a database shell at the same time."
        },
        {
          "type": "table",
          "headers": [
            "Property",
            "Value"
          ],
          "rows": [
            [
              "Exists in",
              "The system org only, seeded next to Super Admin, Admin, Member and Ecosystem Manager when the system org is created. The org creator is not added to it."
            ],
            [
              "Immutable",
              "system: true, re-synced to PLATFORM_OPERATOR_PERMISSIONS by the startup backfill (seedBundle: 'platform_operator')."
            ],
            [
              "grantsRole",
              "member — no admin rights over the system org, and it never sets User.isSuperAdmin."
            ],
            [
              "Permissions",
              "platform:read, orgs:read, oncall:manage, observability_console:open, quotas:manage, plugin_queue:manage, plus the reads that make those views usable: registry:read, observability:read, dashboards:read, subscriptions:read. (billing:operate moved to Account Manager — minting a discount token is commercial, not operational.)"
            ],
            [
              "Deliberately not carrying",
              "database_console:open and objectstore_console:open (staffing an operator must not hand over a data shell as a side effect), and plugins:moderate / publishers:verify (a different job with its own Role)."
            ],
            [
              "Who can assign it",
              "Super Admins only, same ceiling as Ecosystem Manager."
            ]
          ]
        },
        {
          "type": "text",
          "content": "The system org's Roles"
        },
        {
          "type": "text",
          "content": "The system org seeds nine Roles. All but Super Admin set grantsRole: 'member' — no admin rights over the system org, and none of them sets User.isSuperAdmin. A member may hold any number of them: effective permissions are the deduplicated union, so one person covering two jobs gets two Roles rather than a bespoke one."
        },
        {
          "type": "table",
          "headers": [
            "Role",
            "The job",
            "Carries"
          ],
          "rows": [
            [
              "Platform Observer",
              "look, don't touch",
              "platform:read, orgs:read, subscriptions:read, observability:read, dashboards:read, registry:read. The ladder's read-only bottom rung, and the one that was missing: every other bundle grants a write, and the exception (Console Administrator) grants a read that IS a database shell — so somebody who should see the deployment without changing it had only the Super Admin flag or nothing. Every permission ends :read, so the dashboard disables every write affordance rather than offering controls that 403. Deliberately not audit:read: listAuditEvents pins every non-superadmin to their own org, so it would look like fleet-wide audit access and not be."
            ],
            [
              "Super Admin",
              "everything",
              "The platform flag, which short-circuits to every permission. The Role is the single source of truth — grantPlatformAdmin assigns it and recomputeUserOrgRole derives the flag from the assignment, so the two cannot drift."
            ],
            [
              "Platform Operator",
              "running the deployment",
              "platform:read, orgs:read, oncall:manage, observability_console:open, quotas:manage, plugin_queue:manage, plus the reads that make those views usable (registry:read, observability:read, dashboards:read, subscriptions:read)."
            ],
            [
              "Account Manager",
              "the commercial relationship",
              "subscriptions:read, subscriptions:manage, orgs:manage, billing:operate, quotas:manage, orgs:read. Holds the destructive half — orgs:manage deletes an organization, subscriptions:manage cancels — so it is the one assigned most rarely."
            ],
            [
              "Console Administrator",
              "the operator consoles",
              "observability_console:open, database_console:open, objectstore_console:open, orgs:read. The three permissions stay separate so a deployment that wants them held by different people can compose narrower Roles by hand — see Operator consoles."
            ],
            [
              "Support Agent",
              "the support desk",
              "support_cases:write, support_content:write, subscriptions:read, orgs:read, messages:read, messages:write. No console, no platform:read, no billing write."
            ],
            [
              "Support Lead",
              "the support desk, plus the authority to look",
              "Support Agent's bundle plus impersonation:open: view a customer's account as one of its users, with that organization's consent, an MFA-grade session and a second factor at the moment of use. It is the only carrier of impersonation:open, which is what keeps that permission from being Super-Admin-only in practice. Does not grant emergency access — breakglass bypasses consent and stays on the flag."
            ],
            [
              "Registry Operator",
              "promoting container images",
              "registry:read, registry:write — browse the registry and copy a tag into the repository a release resolves, and nothing else: no platform:read, no console, no orgs:read. Separate from Platform Operator because promoting a release image is a release decision, not an operational side effect of being on call; the two compose when one person does both. Does not carry registry:purge — an image promoter has no business deleting the image a tenant's pipeline resolves."
            ],
            [
              "Ecosystem Manager",
              "the plugin ecosystem",
              "See above."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Assigning them. Platform → Settings carries a Platform staffing panel: one roster per job Role, showing who holds it, with add and remove. It is the same two role-membership routes the generic Role admin uses, surfaced where the jobs are named — because knowing that \"Support Agent\" is the Role that lets someone work the case queue is the part the Role list cannot tell you, and the observed alternative is reaching for the Super Admin flag. It also answers the question the Role list cannot: who can open a database shell, cancel a subscription, or read our customers' cases?"
        },
        {
          "type": "text",
          "content": "Only a Super Admin can assign one — platform refuses everyone else, an admin or owner of the system org included, with RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN. Any holder can see the rosters read-only. Ecosystem Manager has its own roster on the Ecosystem console, beside the queue it governs; it is the same component."
        },
        {
          "type": "text",
          "content": "Super Admin is deliberately not on that panel. Granting it goes through POST /admin/users/:id/grants, which needs a step-up earned by a second factor and flips User.isSuperAdmin. A dropdown beside four job Roles would make manufacturing another operator look like the same kind of act as staffing the support desk."
        },
        {
          "type": "text",
          "content": "Why billing:operate sits with Account Manager and not Platform Operator. Minting a discount token is a commercial act, not an operational one. The person who restarts a stuck build queue has no reason to hold it."
        },
        {
          "type": "text",
          "content": "What no Role can do. Three routes stay on the Super Admin flag deliberately, and giving them a permission would make every Role above a path to all of it:"
        },
        {
          "type": "table",
          "headers": [
            "Route",
            "Why"
          ],
          "rows": [
            [
              "POST / DELETE /admin/users/:id/grants",
              "It manufactures another operator — it assigns the Super Admin Role and flips the flag. A grantable permission here is privilege escalation by construction."
            ],
            [
              "POST /admin/users/:id/mfa-reset",
              "The single-person account-takeover path. The normal route is the two-person /organization/:id/mfa-resets."
            ]
          ]
        },
        {
          "type": "text",
          "content": "The cross-tenant IdP and KMS surfaces (/admin/org-idp/*, /admin/orgs/:orgId/kms-config) name org_idp:write / org_kms:write at the route but their controllers additionally require the flag, so they are superadmin-only in practice: repointing an org's IdP is a way to become any of its users."
        },
        {
          "type": "text",
          "content": "Operator consoles"
        },
        {
          "type": "text",
          "content": "The five consoles are gated by three permissions, one per class, chosen by what a mistaken grant costs:"
        },
        {
          "type": "table",
          "headers": [
            "Permission",
            "Consoles",
            "What it reaches"
          ],
          "rows": [
            [
              "observability_console:open",
              "Grafana, Kiali",
              "Dashboards, traffic and mesh health across every tenant. Read-only. In the Platform Operator Role."
            ],
            [
              "database_console:open",
              "pgAdmin, mongo-express",
              "A direct read/write shell over every tenant's rows."
            ],
            [
              "objectstore_console:open",
              "RustFS (S3)",
              "List and delete objects in the registry, Loki, Thanos, plugin-build and audit-chain buckets."
            ]
          ]
        },
        {
          "type": "text",
          "content": "All five are listed on the dashboard's Operator consoles card, on every target that serves them — the two AWS trees, minikube and docker. The docker compose stack runs no Istio, so it has no Kiali tile. Only the AWS gateways run the auth_request; on the local targets the same location blocks are served unauthenticated, because reaching those gateways already means local access to the cluster or the host, so the card does not demand a second factor there for a console that checks nothing."
        },
        {
          "type": "text",
          "content": "The last two are split because they are the two halves of the audit tamper-evidence design: the chain's HMAC key lives outside the database, so a Mongo shell can tamper but cannot forge a consistent chain — except by truncating the tail, which a chain cannot detect from the inside, and the defence against that is the signed chain-head export to object storage. One shell can truncate; the other can delete the heads that would expose it."
        },
        {
          "type": "text",
          "content": "The split is not a containment boundary, and nothing should be built on it as one: Roles live in Mongo, so a database_console:open holder can grant themselves the other two. What it does is keep the default grant small and make each refusal legible. What actually protects the audit heads from whoever opens that console is S3 Object Lock with a retain-until-date."
        },
        {
          "type": "text",
          "content": "Granting them. These are system-org-only, so no tenant Role can carry them. The seeded Console Administrator Role carries all three; assigning it is the usual path. For a narrower grant, a Super Admin authors a Role in the system org containing just the console permission intended — that is how you give somebody pgAdmin and nothing else, with no flag and no impersonation."
        },
        {
          "type": "text",
          "content": "Keeping database_console:open and objectstore_console:open in different hands is the stricter posture, since together they are the two halves of the tamper-evidence design described above. Console Administrator deliberately does not enforce that; it is a convenience bundle, and the separation remains available to a deployment that wants it."
        },
        {
          "type": "text",
          "content": "On every request. The gateway runs an auth_request to platform's GET /admin/console-check, which requires the console's own permission, the system org as the active org, and a session that reached AAL2. Requiring the active org makes entering a console a deliberate context switch, so the audit trail never reads as if a datastore-wide session began inside a tenant. A console nginx serves without naming itself falls back to requiring the Super Admin flag."
        }
      ]
    },
    {
      "id": "enforcement",
      "title": "Enforcement",
      "blocks": [
        {
          "type": "text",
          "content": "Routes gate writes with permission middleware; a denied state-changing request also emits an authz.denied audit event."
        },
        {
          "type": "text",
          "content": "Authority is the union of the caller's Roles' permissions, not the coarse Owner/Admin label. The label governs ownership and seats only: a route gated on org_settings:write (or org_impersonation:write, members:manage, …) admits a custom Role that holds that permission exactly as it admits an admin, and the controller behind it adds only the tenancy check — the target must be the caller's active org or a team under it. So delegating org_settings:write to a custom Role lets its holders edit the org's identity, security policies (MFA, password, authenticator), verified domains and join requests, export it, and delete or restore its teams; a member without the permission is refused by the route."
        },
        {
          "type": "note",
          "content": "Not the same as the mesh. This page covers application authorization — per-org capability checks on API routes. Beneath it, the Istio ambient service mesh enforces network authorization (L4, by service identity): which services may reach which services at all. A request must pass both — the mesh AuthorizationPolicy (can sa/pipeline reach platform:3000?) and then requirePermission (does this user hold the capability?). Don't conflate a mesh 403 (identity not allow-listed) with an app 403 (missing permission). For the INTERNAL routes the two layers name the same callers deliberately — the app gate because docker compose runs no mesh, the mesh policy as defence in depth where one exists."
        },
        {
          "type": "table",
          "headers": [
            "Middleware",
            "Semantics"
          ],
          "rows": [
            [
              "requirePermission(a, b, …)",
              "passes if the caller holds any of the listed permissions (Super Admin passes via implicit-all)"
            ],
            [
              "requireAllPermissions(a, b, …)",
              "passes only if the caller holds all listed permissions"
            ],
            [
              "requirePermissionOrService(a, …)",
              "like requirePermission, but ALSO admits an internal service:* principal — used on READ routes that both users and service-to-service callers hit (a service token carries no permission claims and would otherwise be wrongly denied)"
            ],
            [
              "requireSystemAdmin",
              "platform-operator routes: the isSuperAdmin claim only, never an org permission"
            ],
            [
              "requireServicePrincipal",
              "a signed service:* token, never a user"
            ],
            [
              "requireInternalService({ callers })",
              "internal routes (/internal/, the quota usage counters, the entity-event / audit ingests, the entitlement sync legs): a signed service: token whose name is one of callers, never a user token — not even a superadmin's. The name is bound to the signing key, so this is an identity check, not a claim check. Refusals increment internal_route_refused_total{service,route,reason,caller} and emit authz.denied"
            ],
            [
              "requireAssurance({ minAssurance: 2 })",
              "the SESSION must have been opened with a second factor (aal: 2); a single-factor one gets 401 MFA_REQUIRED, a machine credential 403 HUMAN_SESSION_REQUIRED"
            ],
            [
              "requireOrgAdminAssurance({ machines })",
              "the org's \"administrative actions require MFA\" policy: while it is on (the org_admin_aal claim), a single-factor session gets 401 MFA_REQUIRED; machines: 'allow' lets PATs / service accounts through, 'refuse' answers them 403 HUMAN_SESSION_REQUIRED. A no-op while the policy is off"
            ],
            [
              "requireSystemOrg",
              "the caller's active org (token organizationId) must be the system org — compared by id, never by name. A token minted in a tenant org is refused 403 SYSTEM_ORG_REQUIRED even for the same person, Super Admins included; refusals increment system_org_guard_refused_total and emit authz.denied (required: 'system-org')"
            ],
            [
              "requireSystemOrgPermission(p, …)",
              "the gate for a plugin-ecosystem governance route: requireSystemOrg + requirePermission(p, …) + requireAssurance({ minAssurance: 2 }). Only takes system-org-only permissions (throws at definition time otherwise). Destructive actions add requireStepUp on top"
            ],
            [
              "audited('<action>')",
              "declares the audit action the route's handler emits — metadata for the route table, a no-op at runtime"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Assurance tiers"
        },
        {
          "type": "text",
          "content": "Permissions say who may do something; assurance says how strongly the session doing it was opened (see Assurance levels and required MFA). Two tiers sit on top of the permission gates:"
        },
        {
          "type": "table",
          "headers": [
            "Always aal: 2 (whatever the org's settings)",
            "By policy (adminActionsRequireMfa)"
          ],
          "rows": [
            [
              "Loosening the org MFA policy (mfa-policy: require-MFA off, admin-actions off, \"IdP enforces MFA\" on) — tightening stays open to aal: 1",
              "Roles: create / update / delete, add / remove members (roles:manage)"
            ],
            [
              "Loosening the impersonation policy (less strict mode, self-approval on)",
              "IdP group → Role mappings (roles:manage)"
            ],
            [
              "Service-account create and key issue (service_accounts:manage)",
              "Members: add, bulk-add, remove, deactivate, activate (members:manage)"
            ],
            [
              "Ownership transfer",
              "Invitations: send, revoke, resend (invitations:manage)"
            ],
            [
              "Sysadmin user edit / delete / feature overrides / bulk delete",
              "Billing: subscription create / update / cancel / reactivate, checkout, portal, add-ons, discounts, Marketplace claim (billing:manage)"
            ],
            [
              "MFA reset: request, approve, sysadmin direct reset",
              "Log export (logs:export)"
            ],
            [
              "Impersonation, per-org KMS, IdP config, platform-admin grants (+ second-factor step-up)",
              "Access-key creation and opening a machine credential (person only)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The policy is set on the org's two-factor card (PATCH /organization/:id/mfa-policy, adminActionsRequireMfa), inherited by teams (strictest wins), and carried to every service as the org_admin_aal token claim — changing it bumps every affected member's session. Machine credentials pass the by-policy gates on routes automation legitimately drives and are refused where the action would mint another credential; the per-route decision is in the route table (orgAdminAssurance.machines)."
        },
        {
          "type": "text",
          "content": "Route coverage"
        },
        {
          "type": "text",
          "content": "Gates sit partly on router mounts and partly on individual routes, so grepping the source can't prove coverage. Instead every gate middleware carries metadata and buildRouteTable(app) (api-core middleware/route-table.ts) walks the assembled Express app, resolving per method + path what runs before the handler: permissions, system-admin, service principal, the internal-route caller list, step-up (and, where it names them, which factors may earn it), the minimum assurance level and maxAge, feature flag, token scope and the declared audit action. Each service logs a summary of its own table at boot (Route table built)."
        },
        {
          "type": "text",
          "content": "Every service (and platform) has a test/route-coverage.test.ts that fails when:"
        },
        {
          "type": "list",
          "items": [
            "a write route (anything but GET/HEAD/OPTIONS) has no permission gate, or"
          ]
        },
        {
          "type": "text",
          "content": "declares no audit action;"
        },
        {
          "type": "list",
          "items": [
            "a read route has no permission gate;",
            "a route has a permission gate but no requireAuth (the gate could never see a user);",
            "a route whose path contains /internal/ is not gated by requireInternalService"
          ]
        },
        {
          "type": "text",
          "content": "— with no exception list: a peer-service API a browser can reach is the failure that rule exists to prevent."
        },
        {
          "type": "text",
          "content": "The plugin and image-registry tests also run findSystemOrgGuardViolations (the governance check, governance): any route whose permission gate names a system-org-only permission must also run requireSystemOrg and require aal: 2 — again with no exception list. It passes on a table with no governance route, so it is wired in before the first one exists and bites the day one lands without requireSystemOrgPermission."
        },
        {
          "type": "text",
          "content": "An internal route counts as gated on its own (the gate is stricter than any user permission), and findInternalRouteViolations additionally checks each service's declared internal routes and their caller lists against the code in both directions — so adding or re-scoping one is a visible change, and the Istio policies that name the same callers (deploy/*/k8s/istio-internal-routes.yaml) have one authoritative list to be reviewed against."
        },
        {
          "type": "text",
          "content": "Routes that legitimately can't satisfy a rule — liveness/readiness/metrics probes, signature-verified webhooks, pre-auth sign-in endpoints, internal service-principal hooks, ticket-gated SSE streams, and the handful of routes whose authorization is genuinely dynamic in the handler (e.g. \"the row's creator may write it\") — are listed in that test's EXCEPTIONS array, each with a reason. An exception that stops waiving anything also fails the test, so the allowlist can't rot."
        },
        {
          "type": "text",
          "content": "Each test also writes its table to frontend/src/generated/route-table/<service>.json (regenerate with UPDATE_ROUTE_TABLES=1), and the frontend's test/route-permissions.test.tsx asserts that every gated control matches the route it calls on EVERY dimension the table records — permissions, entitlements (features), step-up, scopes, assurance and the admin-actions MFA policy (orgAdminAssurance) — so a UI gate can't drift from the API. Its GATED_ROUTES_WITHOUT_A_CONTROL registry closes the other direction: a route that gains a gate must be mapped to the control that calls it or listed there with a reason, or the test fails naming the route."
        },
        {
          "type": "text",
          "content": "UI read gates (deep links)"
        },
        {
          "type": "text",
          "content": "Hiding a sidebar link is not a gate — a bookmark, a shared URL or a post-login redirect lands on the page regardless. frontend/src/lib/page-access.ts declares what every dashboard route requires, DERIVED from the same NAV_SECTIONS entry the sidebar filters on (pages with no nav entry of their own are listed explicitly), and useAuthGuard applies it with no per-page options. A viewer who lacks it gets one <AccessDenied> state naming the missing permission, re-evaluated on every render so a role change or org switch mid-session flips the open page rather than leaving its panels to 403 one by one. frontend/test/page-access.test.ts asserts every page under pages/dashboard/ is declared and that every gated page renders the refusal."
        },
        {
          "type": "text",
          "content": "Switching organizations does not strand you on a refusal. Permissions are per-org, and the switcher used to re-render the same path under the new org's token — so switching while standing on a gated page turned the page the person was already reading into <AccessDenied>, a refusal produced by their own working click. OrgSwitcher now re-resolves the route against the post-switch identity (pageGateRefuses, the same three requirements in the same order as the guard) and, when it no longer holds, lands on the dashboard with a notice naming the page that did not come along. frontend/test/page-access-refusal.test.ts asserts the helper and the guard agree for every declared page, so the two cannot drift."
        },
        {
          "type": "text",
          "content": "The switcher names your ROLES, not your role. Each row shows the Roles the person holds in that org, because permissions come only from assigned Roles and the coarse owner/admin/member word grants nothing on its own — a row labelled from it named the one field that is not the answer. An inherited-authority row says \"via parent\" (no membership, so no Roles), and a row whose org requires MFA for admin actions is marked, because switch-org refuses an aal-1 session switching in and the refusal is better stated before the click."
        },
        {
          "type": "text",
          "content": "Entitlements vs permissions in the UI"
        },
        {
          "type": "text",
          "content": "frontend/src/lib/feature-gates.ts records where each feature flag is actually enforced — route (a requireFeature middleware, visible in the route table), handler (checked inside a handler, e.g. the compliance set: tags and the SSO entitlement) or entitlement-only (nothing in the API checks it). Only the first two get a UI lock, rendered by FeatureLock / FeatureLockedAction, which name the entitlement and link to the matching add-on. entitlement-only flags (custom_integrations, and the support_* levels) deliberately gate nothing: locking a control the API serves would take capability away from an org that has it. The parity test enforces both halves."
        },
        {
          "type": "text",
          "content": "One catalog. The permission catalog (ids, labels, descriptions, categories, the picker grouping) lives only in api-core src/types/permissions.ts, a module with no runtime imports. The frontend imports it through the @pipeline-builder/api-core/permissions subpath; there is no hand-kept copy to drift."
        },
        {
          "type": "text",
          "content": "Public-visibility is permission-based too: resolveVisibility grants public only to a caller holding the resource's :publish permission — so a custom Role can be granted publish rights instead of being forced private by its coarse label. Downward report roll-up (?includeDescendants) requires reports:rollup."
        },
        {
          "type": "text",
          "content": "Accounts are not org-scoped. A user account can belong to many organizations, so members:manage covers a member's role in your organization and removing them from it — not the account itself. Changing a user's username, email or password, and deleting an account, are platform-admin actions (PUT/DELETE /users/:id, both behind step-up on an aal: 2 session). Resetting a member's second factors is an org action, but a two-person one: an owner/admin requests it and a different owner/admin (or a sysadmin) approves it — see Recovery when every factor is lost. An org admin who needs someone locked out removes or deactivates the membership."
        }
      ]
    },
    {
      "id": "session-invalidation",
      "title": "Session invalidation",
      "blocks": [
        {
          "type": "text",
          "content": "Access tokens are short-lived (15 min) and carry a tokenVersion. On any privilege change (role edit, permission change, superadmin grant/revoke), platform bumps the user's tokenVersion and publishes it to a Redis-backed revocation store; requireAuth rejects a token whose version is behind (fail-open if Redis is unavailable — auth then degrades to natural token expiry, never a lockout)."
        }
      ]
    },
    {
      "id": "impersonation-view-as-user",
      "title": "Impersonation (view as user)",
      "blocks": [
        {
          "type": "text",
          "content": "A read-only \"view as user X\" session reproduces what a tenant sees — for support work, bug reports, \"it looks wrong on my account\"."
        },
        {
          "type": "code",
          "content": "POST /api/admin/impersonate/:userId\nX-Step-Up-Token: <token>"
        },
        {
          "type": "text",
          "content": "Who can open one. Three permissions, because three different parties are involved and each decision belongs to a different one of them:"
        },
        {
          "type": "table",
          "headers": [
            "Permission",
            "Who holds it",
            "What it allows"
          ],
          "rows": [
            [
              "impersonation:open",
              "System-org-only. The Support Lead Role, and a Super Admin implicitly.",
              "Open a session for any user, cross-tenant — still subject to that organization's consent policy."
            ],
            [
              "team_access:open",
              "Org-assignable, in the admin and owner bundles.",
              "An admin/owner of an ancestor org reaching into its own subtree: entering a team it is not a member of (POST /auth/switch-org), and opening a session for one of that team's users."
            ],
            [
              "impersonation:approve",
              "Org-assignable, in the admin and owner bundles.",
              "Answer a consent request on the organization's behalf. The named approver decides their own request regardless — they were asked personally."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Each is checked alongside an authority test, not instead of one, and the second half is load-bearing:"
        },
        {
          "type": "list",
          "items": [
            "the vendor branch requires the caller's active org to be the system org as"
          ]
        },
        {
          "type": "text",
          "content": "well as the permission. team_access:open is org-assignable, so any tenant admin holds it; without the org check a permission claim could carry a tenant across the boundary. (Token confinement already strips system-org-only ids from a tenant-scoped token, so this is a second, independent fence.)"
        },
        {
          "type": "list",
          "items": [
            "the tenant branch requires the admin/owner label as well as"
          ]
        },
        {
          "type": "text",
          "content": "team_access:open, so an org can withhold team access from one of its admins with a custom Role, or hand it to a lead who is not one."
        },
        {
          "type": "text",
          "content": "One permission covers the whole boundary, including the plain switch into a team the person is not a member of. The two acts are not equally sensitive, but what separates them is not a second permission — it is the MFA-grade session, the strong step-up and the team notification that the impersonation path carries and the switch does not. team_access:open answers \"may this admin reach into teams at all?\"; the step-up machinery answers \"may they go as far as becoming one of their members?\". A switch into an org the person IS a member of needs none of it."
        },
        {
          "type": "text",
          "content": "A Super Admin acting in a tenant org has no impersonation authority and must switch back to the system org — the same rule every other cross-tenant surface already applies via requireSystemOrg."
        },
        {
          "type": "text",
          "content": "A parent organization already administers its descendant teams' members, quotas and secrets, so no separate approval applies within the account. This is strictly downward: a team admin gets no authority over the parent, a sibling team is not in the subtree, and an admin of the user's own org does not qualify — that would be \"any admin may view any of their members\", which this is not. Members get nothing in either direction."
        },
        {
          "type": "note",
          "content": "The parent is not bound by its team's policy. A team may set emergency access only and an admin of its parent organization still opens an ordinary session, without being refused and without being asked. The team is told, not asked (see the notice below). This is deliberate: making a team's policy bind its own parent would invert the authority relationship the whole hierarchy rests on. It is stated here because the policy page otherwise reads as though it binds everyone."
        },
        {
          "type": "text",
          "content": "Note what is not a permission: org_impersonation:write governs the policy — whether consent is required at all — not the act. And emergency access carries no permission at all: breakglass bypasses the tenant's consent policy, so it stays on the Super Admin flag and is approved by a second Super Admin (four-eyes). A permission that can be delegated through a Role must not be able to walk past consent."
        },
        {
          "type": "text",
          "content": "Every caller must also hold an MFA-grade session and pass a step-up earned by a passkey or an authenticator code — a password re-prompt proves nothing an attacker already holding the session doesn't have. The response is an access token carrying the target user's identity, valid for 15 minutes. No refresh token is issued."
        },
        {
          "type": "text",
          "content": "When a parent-org admin opens a session, the team's admins are notified — they are informed, not asked."
        },
        {
          "type": "text",
          "content": "It is read-only, enforced server-side. The token carries an impersonationReadOnly claim, and every request that isn't GET, HEAD or OPTIONS is rejected with IMPERSONATION_READ_ONLY. No state change can land under a borrowed identity."
        },
        {
          "type": "text",
          "content": "What it will not do:"
        },
        {
          "type": "table",
          "headers": [
            "Refused",
            "Why"
          ],
          "rows": [
            [
              "Impersonating yourself",
              "No purpose; rejected 400"
            ],
            [
              "Impersonating another sysadmin",
              "Stops a compromised sysadmin laundering authority through a peer's identity"
            ],
            [
              "Impersonating from inside an impersonation session",
              "Keeps the audit trail a single hop — always requester → user, never chained"
            ],
            [
              "A user with no resolvable organization",
              "There is no org to pin the session to (non-sysadmin callers)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Tenancy. The issued token is built from the target's identity, so it carries no isSuperAdmin claim — which means the x-org-id override is unavailable during impersonation. The session is pinned to one organization (today, the target's active org) and resolved strictly: if the target has no live membership there — or that org is soft-deleted — the token is issued with no organization context rather than falling back to some other org they belong to. An operator who asked to view a specific organization is never silently placed in a different one. It is not a way to roam between tenants."
        },
        {
          "type": "text",
          "content": "Visibility. Starting a session emits admin.impersonate.start, filed under the organization the session is pinned to rather than the system org — so that org's admins see it in their own audit view, not just platform operators. The event carries a requestId and an approvalReason, and actions taken during the session carry the sysadmin in a first-class impersonatorId field. See Audit Events."
        },
        {
          "type": "text",
          "content": "Every session is recorded. Each one creates an impersonation request that the token is then redeemed against — there is no path that issues a token without a record. An approval is single-use, so a request cannot be redeemed twice. The request's approvalReason records why it was allowed: policy_open (nobody had to be asked), ancestor_authority (a parent org's admin), consent (someone approved), or breakglass (emergency access)."
        },
        {
          "type": "text",
          "content": "Administrator access policy"
        },
        {
          "type": "text",
          "content": "Each organization chooses whether platform sysadmins may view its members' accounts, under Settings → Organization → Administrator access. Changing it requires the org_impersonation:write permission and re-entering your password."
        },
        {
          "type": "table",
          "headers": [
            "Policy",
            "Shown as",
            "What happens when a sysadmin asks"
          ],
          "rows": [
            [
              "open",
              "Open",
              "The session starts immediately. It is still logged."
            ],
            [
              "consent (default)",
              "Ask first",
              "The request waits. Someone must approve it within 1 hour."
            ],
            [
              "denied",
              "Emergencies only",
              "Refused. Only emergency access remains."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Who is asked. By default the request goes to the member whose account it is. An organization can turn off Let members approve access to their own account; requests then go to its admins, and the first to answer decides. A sysadmin who explicitly asks for the member to approve, in an organization that forbids it, is refused rather than silently redirected."
        },
        {
          "type": "text",
          "content": "Strictest wins across teams. A team can make its policy stricter than its parent's, never looser: the policy that applies is the stricter of the two, and self-approval is allowed only if both allow it. The settings page shows when a parent's policy is overriding the team's own. If the parent's policy can't be read, the strictest policy applies until it can."
        },
        {
          "type": "text",
          "content": "denied can't be selected on a deployment with fewer than two sysadmins, because emergency access under it needs a second sysadmin to approve."
        },
        {
          "type": "text",
          "content": "Approving. The request appears on the approver's Access requests page, and they are notified in the app. Approving shows exactly what is being granted — who, whose account, for how long, and that it's view-only. The requester is notified of the decision either way, and opens an approved session from their own Access requests page, which asks for their password again. An approval that isn't opened within the hour lapses and shows as expired. A request nobody could be notified about is reported to the requester immediately rather than left waiting."
        },
        {
          "type": "text",
          "content": "Admins of a parent organization are not subject to the policy when viewing their own teams' members: the team's admins are informed, not asked. They do this from Members → View a team member's account, which appears for admins of an organization that has teams: pick a team, then View as user on a member. The request names that team, so the session is scoped to it regardless of which organization the member last had active."
        },
        {
          "type": "text",
          "content": "Through the API, an impersonation request may name the organization explicitly:"
        },
        {
          "type": "code",
          "content": "POST /api/admin/impersonate/:userId\n{ \"orgId\": \"<team id>\" }"
        },
        {
          "type": "text",
          "content": "The user must be an active member of that organization, or the request is refused. Without orgId, the session is for the user's active organization."
        },
        {
          "type": "text",
          "content": "Seeing and ending sessions. Every signed-in user has an Access requests page (/dashboard/access-requests, under Home in the sidebar). It lists live sessions on your own account, sessions you opened, and — for an organization admin — sessions on your organization's members, each with an End session button. Ending a session takes effect immediately after one plain confirmation — never a step-up, so stopping access is never harder than granting it — because it can't be undone: to look again the operator must ask, and be approved, again. Each list on the page is paged (GET /api/admin/impersonate/requests?view=…&limit=&offset=, newest first, returning pagination.total)."
        },
        {
          "type": "text",
          "content": "Stop impersonating ends the session on the server as well as in the browser, so the token stops working rather than remaining valid until it expires."
        },
        {
          "type": "text",
          "content": "A live session can also be revoked through the API:"
        },
        {
          "type": "code",
          "content": "POST /api/admin/impersonate/requests/:id/revoke"
        },
        {
          "type": "text",
          "content": "Permitted to the impersonated user, an admin of the pinned organization, whoever approved it, or the requester. Each session's token carries its own jti, so revoking ends that session only — the impersonated user's own sessions are untouched. The next request under a revoked token is rejected, rather than the session running out its 15-minute TTL."
        },
        {
          "type": "text",
          "content": "Revocation reaches every service. The platform refuses a revoked session's token directly; ending a session also publishes it to Redis, which every other service checks on each impersonated request. If that publish fails, the response carries revokedEverywhere: false and the Access requests page warns that the session may keep working elsewhere until it expires, rather than reporting it ended."
        },
        {
          "type": "text",
          "content": "A service that cannot read Redis rejects impersonation tokens — it cannot tell whether the session was ended, and a withdrawn session that keeps working is not withdrawn. Ordinary user sessions are unaffected by a Redis outage."
        },
        {
          "type": "text",
          "content": "Emergency access. A sysadmin can take read-only access without waiting for approval, for incidents where the account's owner can't or shouldn't be asked (Emergency access… on the user's edit dialog):"
        },
        {
          "type": "code",
          "content": "POST /api/admin/impersonate/:userId/breakglass\n{ \"justification\": \"INC-1234: customer pipelines failing since 09:10\" }"
        },
        {
          "type": "text",
          "content": "It is deliberately expensive rather than blocked:"
        },
        {
          "type": "list",
          "items": [
            "A written justification of at least 20 characters is required, and it is"
          ]
        },
        {
          "type": "text",
          "content": "shown to the organization."
        },
        {
          "type": "list",
          "items": [
            "Every admin of the organization is notified immediately, including how many"
          ]
        },
        {
          "type": "text",
          "content": "times this operator has used emergency access in the last 30 days."
        },
        {
          "type": "list",
          "items": [
            "A second sysadmin must approve it before any token is issued when the"
          ]
        },
        {
          "type": "text",
          "content": "organization's policy is denied, or when the operator has already used emergency access 5 times in 30 days. The response is then 202 with awaiting: \"second_sysadmin\"; the second sysadmin approves it from their Access requests page, and the requester opens it from there."
        },
        {
          "type": "list",
          "items": [
            "It is audited as admin.impersonate.breakglass, never as an ordinary start.",
            "A user with no organization cannot be reached this way — there would be nobody"
          ]
        },
        {
          "type": "text",
          "content": "to notify."
        },
        {
          "type": "text",
          "content": "No one — including a sysadmin — can approve their own request."
        }
      ]
    },
    {
      "id": "managing-roles-via-the-api",
      "title": "Managing Roles via the API",
      "blocks": [
        {
          "type": "code",
          "content": "GET|POST    /api/organization/:id/roles                       # list / create Roles\nPUT|DELETE  /api/organization/:id/roles/:roleId               # update / delete a custom Role\nPOST|DELETE /api/organization/:id/roles/:roleId/members/:uid  # add / remove a Role member",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "POST / PUT / DELETE require roles:manage. Custom-Role authoring validates the requested permissions against the org-assignable set (the registry and system-org-only carve-outs are rejected) and against the author's own permissions (the permission ceiling above) — a request granting a permission the author lacks is rejected 403."
        },
        {
          "type": "text",
          "content": "IdP group → Role mappings"
        },
        {
          "type": "code",
          "content": "GET|POST    /api/organization/:id/idp/group-mappings              # list / create a mapping\nPUT|DELETE  /api/organization/:id/idp/group-mappings/:mappingId   # update / delete a mapping",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Every route requires roles:manage, not org_idp:write: a mapping grants Roles at SSO sign-in, so it belongs to whoever governs Roles — an org can delegate the login connection (org_idp:write) and the Role policy (roles:manage) to different people. The controller adds the own-org / managed-team scope and the sso entitlement; the service applies the same assignment ceiling as a direct Role assignment, in both directions (what a rule would grant, and what it already grants, when it is edited or deleted)."
        },
        {
          "type": "text",
          "content": "Two refusals are specific to mappings:"
        },
        {
          "type": "list",
          "items": [
            "a mapping can never name a Role conferring platform-admin, and never grants"
          ]
        },
        {
          "type": "text",
          "content": "org ownership — for org admins and platform superadmins alike, because a mapping keeps granting for as long as an external directory says so;"
        },
        {
          "type": "list",
          "items": [
            "the provider must issue group claims. Google does not, so configuring a groups"
          ]
        },
        {
          "type": "text",
          "content": "claim or a mapping on a google config is refused (IGM_PROVIDER_UNSUPPORTED). See just-in-time membership."
        },
        {
          "type": "text",
          "content": "Roles assigned by hand are tracked separately from mapped ones and are never removed when a group stops matching."
        },
        {
          "type": "text",
          "content": "Invitations"
        },
        {
          "type": "text",
          "content": "An invitation is gated on invitations:manage and nothing coarser. That is worth stating because it was not true until recently: the service demanded owner-or-admin on every write, which made the permission unusable — the route admitted it, the service refused it, and the shipped People Manager template (which grants invitations:manage and is deliberately not admin) could not send a single invitation."
        },
        {
          "type": "table",
          "headers": [
            "Act",
            "Needs"
          ],
          "rows": [
            [
              "List, send, revoke, resend",
              "invitations:manage, or ownership of the org"
            ],
            [
              "Invite someone as admin",
              "…and the admin/owner label as well — a CEILING, with its own error, because onboarding people is not the same act as minting a peer who holds every org-assignable permission"
            ]
          ]
        },
        {
          "type": "text",
          "content": "An invitation can carry Roles. roleIds names Roles to assign on acceptance, so hiring into a job does not mean inviting someone as admin and demoting them afterwards, or inviting them as a member and remembering to assign later. The same field has always existed on the user-admin API; the invitation was the path that lacked it, which left every Role template without an onboarding route."
        },
        {
          "type": "text",
          "content": "Four guards, all in partitionAssignableRoles:"
        },
        {
          "type": "list",
          "items": [
            "Org scope. The lookup is filtered by organizationId, so a Role id from"
          ]
        },
        {
          "type": "text",
          "content": "another org does not resolve. A Role id is not a capability."
        },
        {
          "type": "list",
          "items": [
            "Never the Super Admin Role, for anyone including a Super Admin. The"
          ]
        },
        {
          "type": "text",
          "content": "platform flag is granted by POST /admin/users/:id/grants behind a step-up earned by a second factor; an emailed bearer token must not reach the same grant. A permission ceiling would not catch this, because what that Role confers is grantsRole, not a permission list."
        },
        {
          "type": "list",
          "items": [
            "The system-org carve-out and the actor's ceiling, both via"
          ]
        },
        {
          "type": "text",
          "content": "assertActorMayAssignRole — the same guard the Role-membership API uses, so an invitation cannot grant what an assignment would refuse."
        },
        {
          "type": "list",
          "items": [
            "Validated twice. Once when the invitation is sent, where a rejection fails"
          ]
        },
        {
          "type": "text",
          "content": "the whole request (the ids are the same for every address in the batch, so it is not a per-address outcome), and again at acceptance against the inviter's current authority. An invitation can sit pending for days; a Role the inviter can no longer grant is dropped and logged, and the invitee still joins — refusing their acceptance over their inviter's demotion is the worse trade."
        },
        {
          "type": "text",
          "content": "The system org. Nothing about invitations is special-cased for it, and that is deliberate: inviting into the system org confers Admin or Member of the system org, which is tenant-shaped authority. The system-org-only permissions live in job Roles that only a Super Admin may assign, from the Platform staffing panel. So onboarding vendor staff stays two acts by two people — an invitation, then a deliberate staffing decision. No system-org job Role carries invitations:manage; only the system org's own Admin Role does."
        },
        {
          "type": "text",
          "content": "Service accounts"
        },
        {
          "type": "code",
          "content": "GET         /api/organization/:id/service-accounts                      # list accounts + their keys\nPOST        /api/organization/:id/service-accounts                      # create an account\nGET         /api/organization/:id/service-accounts/:accountId           # one account\nPATCH       /api/organization/:id/service-accounts/:accountId           # description / roles / budget / disabled\nDELETE      /api/organization/:id/service-accounts/:accountId           # delete the account + every key\nPOST        /api/organization/:id/service-accounts/:accountId/keys      # issue a pb_sa_ key (shown once)\nDELETE      /api/organization/:id/service-accounts/:accountId/keys/:id  # revoke one key",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "EVERY route here requires service_accounts:manage — the listing is an inventory of the org's machine credentials, so it is not a member-level read (it carries no secret either way: a key is shown once, at creation). Writes add step-up, except key REVOCATION, which is deliberately left at the permission alone so a compromised key can be killed without a second factor."
        },
        {
          "type": "text",
          "content": "A service account's Roles go through the same assignment ceiling as a person's: the caller must already hold every permission the Role grants, and only a platform superadmin may grant a superadmin-granting Role. A service account therefore can never exceed its creator's permissions. It also can never satisfy step-up itself (requireStepUp refuses the principal), so one machine key can never be used to mint another."
        },
        {
          "type": "text",
          "content": "SCIM (/api/scim/v2) — a capability SCOPE, not a permission"
        },
        {
          "type": "code",
          "content": "GET|POST          /api/scim/v2/Users            GET|PUT|PATCH|DELETE  /api/scim/v2/Users/:id\nGET|POST          /api/scim/v2/Groups           GET|PUT|PATCH|DELETE  /api/scim/v2/Groups/:id\nGET               /api/scim/v2/ServiceProviderConfig | /ResourceTypes | /Schemas",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "These routes carry no requirePermission, and that is deliberate rather than an omission. They are gated by requireScimScope, which admits only a service-account token carrying the scim capability scope — and a scoped token is minted with permissions: [], features: [], role: 'member' and no admin flags, whatever the account holds. There is therefore no permission for the caller to hold; the scope IS the authority, and the route-coverage test records it as such (scopes: [\"scim\"] on the generated route table, with a named exception)."
        },
        {
          "type": "text",
          "content": "Three consequences worth stating, because they are what keeps a leaked SCIM key small:"
        },
        {
          "type": "list",
          "items": [
            "It cannot escalate. SCIM owns a directory group's NAME and MEMBERS; it"
          ]
        },
        {
          "type": "text",
          "content": "never writes a group's roleIds. Deciding what a group is worth stays a roles:manage action in the dashboard, so a stolen key can move people between groups but cannot invent a group that grants admin. Roles it does grant are sync-owned — a hand-granted Role is never removed by a sync."
        },
        {
          "type": "list",
          "items": [
            "It cannot reach another tenant. No org id appears in any path; the org is"
          ]
        },
        {
          "type": "text",
          "content": "the key's own, resolved from the verified token."
        },
        {
          "type": "list",
          "items": [
            "It cannot touch the untouchable. The org owner is never deactivated or"
          ]
        },
        {
          "type": "text",
          "content": "removed through SCIM, and a platform administrator is never provisioned or modified at all."
        },
        {
          "type": "text",
          "content": "Issuing the key is the privileged act, and that is permission-gated: service_accounts:manage + step-up, on the ordinary key-mint route above. The UI for it sits on Settings → Single Sign-On, gated on the same permission. See SCIM 2.0 provisioning for the seat, verified-domain, session-revocation and post-downgrade rules."
        }
      ]
    },
    {
      "id": "teams",
      "title": "Teams",
      "blocks": [
        {
          "type": "text",
          "content": "A parent-org admin/owner can administer its teams (members, rules, quotas) without a separate membership — fine-grained delegation applies within the team's own tenancy boundary, and team-local Roles still bind. See Org → Team Hierarchy."
        },
        {
          "type": "text",
          "content": "Cross-organization reach"
        },
        {
          "type": "text",
          "content": "Except for platform sysadmins (the system organization), an organization cannot reach into another organization unless it is that organization's child team."
        },
        {
          "type": "text",
          "content": "This governs every way of acting on an organization you are not a member of:"
        },
        {
          "type": "table",
          "headers": [
            "Reaching into…",
            "From the same org",
            "From its parent",
            "From a sibling team",
            "From its child team",
            "From a separate account"
          ],
          "rows": [
            [
              "Administering it",
              "admins",
              "admins ✅",
              "❌",
              "❌",
              "❌"
            ],
            [
              "Reading it",
              "members",
              "admins ✅",
              "❌",
              "❌",
              "❌"
            ],
            [
              "Impersonating a member",
              "❌",
              "admins ✅",
              "❌",
              "❌",
              "❌"
            ],
            [
              "Overriding the org via x-org-id",
              "sysadmin only",
              "",
              "",
              "",
              ""
            ]
          ]
        },
        {
          "type": "text",
          "content": "A sysadmin can do all of these for any organization. Reach only ever flows down the tree, from a parent to its teams."
        },
        {
          "type": "text",
          "content": "Switching organizations is different. Switching your active organization follows your own memberships: you can switch to any organization you are an active member of, including a separate one. Being a parent admin does not let you switch into a team you don't belong to — you administer and view it from the parent instead."
        }
      ]
    },
    {
      "id": "related",
      "title": "Related",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Authentication — sign-in, step-up re-auth, SSO",
            "Audit Events — the event catalog, including admin.impersonate.*",
            "Organization Benefits — org, team and account structure",
            "API Reference — route-level permission requirements"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/permissions.md"
};
