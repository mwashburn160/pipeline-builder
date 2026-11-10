// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system org's built-in JOB Roles — the staffing surface's source list.
 *
 * Each name comes from api-core's `SEED_BUNDLES` — the SAME table
 * `seedDefaultRoles` seeds from — because the name is the handle: Role ids are
 * per-install, so there is nothing stable to reference.
 *
 * IT USED TO BE A SECOND HARD-CODED LIST. The platform seeded names from its own
 * constants while this file spelled them again, each pinned by a test against
 * its own copy — so a rename passed both suites and the roster rendered "Role
 * not found", which is the grant path for that Role's permissions quietly
 * disappearing. Only the DESCRIPTIONS are owned here now; they are product
 * copy, and they are the reason this list exists at all.
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
 *  - **Ecosystem Manager** and **Publisher Verifier.** Both have their panels on
 *    the Ecosystem console, beside the queue they govern, which is where the
 *    people who use them already are. Both render the SAME roster component as
 *    these.
 */

import { SEED_BUNDLES } from '@pipeline-builder/api-core/permissions';

export interface SystemOrgJobRole {
  /** The exact seeded Role name, from api-core's `SEED_BUNDLES`. */
  name: string;
  /** What the job is, in the roster header. */
  description: string;
  /** What it costs for nobody to hold it. */
  emptyDescription: string;
}

export const SYSTEM_ORG_JOB_ROLES: readonly SystemOrgJobRole[] = [
  {
    name: SEED_BUNDLES.platform_observer.name,
    description: 'Looks and changes nothing: the platform posture, the fleet organization list, subscriptions, dashboards and the registry browser, all read-only.',
    emptyDescription: 'Anyone who needs to see the deployment without touching it has to be made a Super Admin instead.',
  },
  {
    name: SEED_BUNDLES.platform_operator.name,
    description: 'Runs the deployment: the platform settings page, the pager, the observability consoles, quota bumps and the plugin build queue.',
    emptyDescription: 'Nobody can read the platform posture or hold the pager without the Super Admin flag.',
  },
  {
    name: SEED_BUNDLES.account_manager.name,
    description: 'Runs the commercial relationship: subscriptions, discounts and promotions, tiers, and the organization lifecycle.',
    emptyDescription: 'Nobody can change a subscription or re-tier an organization without the Super Admin flag.',
  },
  {
    name: SEED_BUNDLES.console_admin.name,
    description: 'Opens the five operator consoles — Grafana, Kiali, pgAdmin, mongo-express and the RustFS object store.',
    emptyDescription: 'The database and object-store consoles are reachable only by a Super Admin.',
  },
  {
    name: SEED_BUNDLES.support_agent.name,
    description: 'Works the support desk: the cross-tenant case queue, assignment and severity, internal notes, and the canned replies.',
    emptyDescription: 'Support cases can only be worked by a Super Admin, and no notice says a case is waiting.',
  },
  {
    name: SEED_BUNDLES.support_lead.name,
    description: "Works the desk and may view a customer's account as one of its users — with that organization's consent, an MFA-grade session and a second factor at the moment of use.",
    emptyDescription: "Seeing what a customer sees needs the Super Admin flag, which also grants emergency access, MFA resets and a database shell.",
  },
  {
    name: SEED_BUNDLES.registry_operator.name,
    description: 'Promotes container images: browse the registry and copy a tag into the repository a release resolves. Deleting an image is not included — that stays with the Super Admin flag.',
    emptyDescription: 'Promoting a built image to a release tag needs the Super Admin flag, which also grants the power to delete it.',
  },
];
