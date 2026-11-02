// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system org's built-in JOB Roles — the staffing surface's source list.
 *
 * Each name is the one `seedDefaultRoles` seeds (platform `roles-service.ts`),
 * and that name is the handle: Role ids are per-install, so there is nothing
 * stable to reference. `frontend/test/platform-staffing.test.tsx` asserts these
 * names against the permission catalog's own copy, so a rename on either side
 * fails rather than silently showing "Role not found".
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *  - **Super Admin.** Granting it is not a Role assignment in the UI's sense: it
 *    goes through `POST /admin/users/:id/grants`, which demands a step-up earned
 *    by a second factor and flips `User.isSuperAdmin`. Putting it in a list of
 *    dropdowns beside four ordinary job Roles would make manufacturing another
 *    operator look like the same kind of act as staffing the support desk.
 *  - **Admin / Member / Team Lead.** Ordinary org Roles, managed where every
 *    org manages them.
 *  - **Ecosystem Manager.** It has its own panel on the Ecosystem console,
 *    beside the queue it governs, which is where the people who use it already
 *    are. It renders the SAME roster component as these.
 */

export interface SystemOrgJobRole {
  /** The exact seeded Role name. */
  name: string;
  /** What the job is, in the roster header. */
  description: string;
  /** What it costs for nobody to hold it. */
  emptyDescription: string;
}

export const SYSTEM_ORG_JOB_ROLES: readonly SystemOrgJobRole[] = [
  {
    name: 'Platform Operator',
    description: 'Runs the deployment: the platform settings page, the pager, the observability consoles, quota bumps and the plugin build queue.',
    emptyDescription: 'Nobody can read the platform posture or hold the pager without the Super Admin flag.',
  },
  {
    name: 'Account Manager',
    description: 'Runs the commercial relationship: subscriptions, discounts and promotions, tiers, and the organization lifecycle.',
    emptyDescription: 'Nobody can change a subscription or re-tier an organization without the Super Admin flag.',
  },
  {
    name: 'Console Administrator',
    description: 'Opens the five operator consoles — Grafana, Kiali, pgAdmin, mongo-express and the RustFS object store.',
    emptyDescription: 'The database and object-store consoles are reachable only by a Super Admin.',
  },
  {
    name: 'Support Agent',
    description: 'Works the support desk: the cross-tenant case queue, assignment and severity, internal notes, and the canned replies.',
    emptyDescription: 'Support cases can only be worked by a Super Admin, and no notice says a case is waiting.',
  },
];
