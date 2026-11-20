// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHAT the org teardown covers: the Postgres tables platform itself owns, every
 * org-scoped table the read-only export walks, and the Mongo collections.
 *
 * Kept apart from `org-cascade-service` (which is HOW the teardown runs) for
 * one reason: this list is the thing that drifts. A new org-scoped table or
 * collection has to be covered or the org's rows outlive the org, so the
 * registry is what the reflection drift-guards in
 * `test/org-cascade-service.test.ts` assert against.
 *
 * POSTGRES OWNERSHIP. Platform DELETES only its own tables (dashboards, alert
 * routing, support contacts — the `platform` slice of pipeline-data's
 * `ORG_DATA_OWNERSHIP`). Every other org-scoped table belongs to the service
 * that writes it, which tears it down itself when platform's durable cascade
 * outbox (`services/cascade-outbox.ts`) delivers its leg — platform never
 * writes another service's tables. The EXPORT still reads every org-scoped
 * table (a read-only GDPR portability artifact / recovery snapshot), so one
 * ownership map drives both and the snapshot can never silently omit a store
 * the cascade removes.
 */

import { ORG_DATA_OWNERSHIP, ORG_SCOPED_TABLE_NAMES, allOrgScopedTables, type OrgScopedTable } from '@pipeline-builder/pipeline-data';
import type { Types } from 'mongoose';
import { toOrgId } from '../helpers/org-id.js';
import IdpGroupMapping from '../models/idp-group-mapping.js';
import ImpersonationRequest from '../models/impersonation-request.js';
import Invitation from '../models/invitation.js';
import JoinRequest from '../models/join-request.js';
import MfaResetRequest from '../models/mfa-reset-request.js';
import OrgDomain from '../models/org-domain.js';
import OrgIdpConfig from '../models/org-idp-config.js';
import PersonalAccessToken from '../models/personal-access-token.js';
import RoleAssignment from '../models/role-assignment.js';
import Role from '../models/role.js';
import SamlSession from '../models/saml-session.js';
import ServiceAccount from '../models/service-account.js';
import UserOrganization from '../models/user-organization.js';

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/** Platform's OWN soft-delete tables (`deleted_at` + `purge_after`): tombstoned by the cascade. */
export const SOFT_DELETE_TABLES: readonly OrgScopedTable[] = ORG_DATA_OWNERSHIP.platform.soft;

/** Platform's OWN hard-delete tables (no `deleted_at`): removed by the cascade. */
export const HARD_DELETE_TABLES: readonly OrgScopedTable[] = ORG_DATA_OWNERSHIP.platform.hard;

/** Every org-scoped table, whoever owns it — what the read-only export walks. */
export const EXPORT_TABLES: readonly OrgScopedTable[] = allOrgScopedTables();

/** Every org-scoped table name that SOME owner tears down (platform or a
 *  downstream service's outbox leg). Exported so a schema-reflection test can
 *  assert that EVERY org-scoped table is covered — turning "added a table,
 *  forgot the cascade" (which silently orphaned org_alert_rules +
 *  pipeline_templates) into a red test. */
export const CASCADE_TABLE_NAMES: ReadonlySet<string> = ORG_SCOPED_TABLE_NAMES;

// ---------------------------------------------------------------------------
// Mongo collections the org teardown covers
// ---------------------------------------------------------------------------

/** One Mongo collection the org teardown removes, and how to read its rows. */
export interface MongoCascadeCollection<N extends string = string> {
  /** Key under `report.mongo` / `export.mongo`. */
  readonly name: N;
  /** Every row belonging to the org — what the export/snapshot must capture. */
  readonly read: (orgId: string) => Promise<unknown[]>;
  /**
   * Remove them, returning the row count. ABSENT means the rows are dropped by
   * `organizationService.delete` (the purge's own transaction) instead of here
   * — they are still the org's data, so they are still exported.
   */
  readonly remove?: (orgId: string) => Promise<number>;
}

/** Service-account ids owned by `orgId` — the key/assignment rows hang off these. */
async function serviceAccountIds(orgId: string): Promise<Types.ObjectId[]> {
  const docs = await ServiceAccount.find({ organizationId: toOrgId(orgId) }).select('_id').lean();
  return docs.map((d) => d._id);
}

/**
 * `AuditEvent` is the one collection not in this table: it is archived in fixed
 * batches and exported under a cap, both of which need their own handling —
 * {@link CASCADE_MONGO_COLLECTION_NAMES} includes it all the same.
 */
const COLLECTION_DEFS = [
  {
    name: 'invitations',
    // Never the `tokenHash`: the plaintext token (each pending invitation's
    // bearer credential, the accept link) is never stored, and the export
    // reaches holders of `org_settings:write` who may lack `invitations:manage`
    // — the same reason `listForOrg` strips even the hash.
    read: (orgId) => Invitation.find({ organizationId: toOrgId(orgId) }).select('-tokenHash').lean(),
    remove: async (orgId) => (await Invitation.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'idpConfigs',
    // Never the OIDC client secret: like a runner key's `private_key_enc`, a
    // secret never leaves in an artifact, encrypted or not — the export reaches
    // `org_settings:write` holders, and the CRUD surface never returns it either.
    read: (orgId) => OrgIdpConfig.find({ organizationId: toOrgId(orgId) }).select('-clientSecretEncrypted').lean(),
    remove: async (orgId) => (await OrgIdpConfig.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'idpGroupMappings',
    read: (orgId) => IdpGroupMapping.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await IdpGroupMapping.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'orgDomains',
    read: (orgId) => OrgDomain.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await OrgDomain.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'joinRequests',
    read: (orgId) => JoinRequest.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await JoinRequest.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // SAML SLO bookkeeping (one row per platform session a SAML sign-in
    // opened). TTL-expiring, but the rows are org-scoped: without this leg a
    // purged org's rows sat in the collection until their refresh window
    // lapsed, and the SLO endpoint kept matching them.
    name: 'samlSessions',
    read: (orgId) => SamlSession.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await SamlSession.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Members' PERSONAL keys (`pb_pat`) minted against this org. Their tokens
    // are scoped to the org, so once it is gone a surviving key is a live
    // credential pointing at nothing — and `createdIp` / `createdUserAgent` are
    // the member's personal data. Service-account keys are the SA leg's.
    // `keyHash` is the stored secret — never in an artifact.
    name: 'personalAccessTokens',
    read: (orgId) => PersonalAccessToken.find({ userId: { $ne: null }, organizationId: toOrgId(orgId) })
      .select('-keyHash').lean(),
    remove: async (orgId) => (await PersonalAccessToken.deleteMany({ userId: { $ne: null }, organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Two-person MFA-reset requests raised inside the org (requester,
    // approver and target identities + reasons).
    name: 'mfaResetRequests',
    read: (orgId) => MfaResetRequest.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await MfaResetRequest.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Consent-gated impersonation requests targeting the org's members.
    name: 'impersonationRequests',
    read: (orgId) => ImpersonationRequest.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await ImpersonationRequest.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Removed (with its keys and Role assignments) by the cascade's
    // service-account leg, which reports BOTH counts — hence no `remove` here.
    name: 'serviceAccounts',
    read: (orgId) => ServiceAccount.find({ organizationId: toOrgId(orgId) }).lean(),
  },
  {
    // `keyHash` is the stored form of the secret — never put it in an artifact
    // handed to an operator or a tenant.
    name: 'serviceAccountKeys',
    read: async (orgId) => {
      const ids = await serviceAccountIds(orgId);
      if (ids.length === 0) return [];
      return PersonalAccessToken.find({ serviceAccountId: { $in: ids } })
        .select('-keyHash').lean();
    },
  },
  // The three below are removed by `organizationService.delete` (one
  // transaction, after this cascade), so they carry no `remove` — but without
  // them a restored org has no members and no Roles.
  {
    name: 'memberships',
    read: (orgId) => UserOrganization.find({ organizationId: toOrgId(orgId) }).lean(),
  },
  {
    name: 'roleAssignments',
    read: (orgId) => RoleAssignment.find({ organizationId: toOrgId(orgId) }).lean(),
  },
  {
    name: 'roles',
    read: (orgId) => Role.find({ organizationId: toOrgId(orgId) }).lean(),
  },
] as const satisfies readonly MongoCascadeCollection[];

/** Every Mongo collection the teardown covers, by its report/export key. */
export type CascadeMongoName = (typeof COLLECTION_DEFS)[number]['name'] | 'auditEvents';

export const MONGO_CASCADE_COLLECTIONS: readonly MongoCascadeCollection<CascadeMongoName>[] = COLLECTION_DEFS;

/**
 * The collections the cascade itself deletes from, and so counts in
 * `report.mongo`: those with a `remove`, the service-account leg (accounts +
 * their keys) and the archived audit chain. Memberships, Role assignments and
 * Roles go with `organizationService.delete` and are counted there.
 */
type RemovableDef = Extract<(typeof COLLECTION_DEFS)[number], { remove: unknown }>;
export type CascadeRemovedName = RemovableDef['name'] | 'serviceAccounts' | 'serviceAccountKeys' | 'auditEvents';

/** The collections whose rows the cascade deletes itself. */
export const MONGO_REMOVABLE: readonly RemovableDef[] = COLLECTION_DEFS.filter((c): c is RemovableDef => 'remove' in c);

/**
 * Every Mongo collection the org teardown removes. Exported so a reflection
 * test can assert each one appears in the export artifact — the Mongo twin of
 * {@link CASCADE_TABLE_NAMES}.
 */
export const CASCADE_MONGO_COLLECTION_NAMES: ReadonlySet<string> = new Set([
  ...MONGO_CASCADE_COLLECTIONS.map((c) => c.name),
  'auditEvents',
]);
