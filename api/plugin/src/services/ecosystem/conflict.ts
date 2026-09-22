// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Separation of duties: who may not decide a publish request (docs/runbooks/ecosystem-moderation.md). */

import { fetchOrgMembership, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { type PluginPublishRequest, type Publisher } from '@pipeline-builder/pipeline-data';

import { type Caller } from './context.js';
import { type PluginRow } from './store.js';

type Req = PluginPublishRequest;
const payloadOf = (r: Req) => (r.payload ?? {}) as Record<string, unknown>;

// -----------------------------------------------------------------------------
// Separation of duties
// -----------------------------------------------------------------------------

export interface Conflict { conflict: boolean; reason: string | null }
const NO_CONFLICT: Conflict = { conflict: false, reason: null };

/** Membership probe (platform), overridable in tests. */
let membershipProbe: (orgId: string, userId: string) => Promise<boolean | undefined> = (orgId, userId) => {
  const { services } = Config.get('server');
  return fetchOrgMembership(orgId, userId, {
    service: { host: services.platformHost, port: services.platformPort, timeout: 5_000 },
    serviceName: 'plugin',
    authOrgId: SYSTEM_ORG_ID,
  });
};

/** Test hook: replace the platform membership probe. */
export function setMembershipProbeForTests(fn: typeof membershipProbe): void {
  membershipProbe = fn;
}

/** The orgs whose members may not decide `r`: the requesting org, the publisher's org, and a transfer's receiving org. */
export function interestedOrgs(r: Req, publisher: Pick<Publisher, 'ownerOrgId'> | null): string[] {
  const orgs = new Set<string>();
  if (r.submittedOrgId) orgs.add(r.submittedOrgId.toLowerCase());
  if (publisher?.ownerOrgId) orgs.add(publisher.ownerOrgId.toLowerCase());
  const target = (payloadOf(r).transfer as { targetOrgId?: string } | undefined)?.targetOrgId;
  if (target) orgs.add(target.toLowerCase());
  // Every manager is a member of the system org; for the Official catalog the
  // rule is "not the uploader" instead (checked separately).
  orgs.delete(SYSTEM_ORG_ID);
  return [...orgs];
}

/**
 * Whether `moderator` may decide `r`. `deep` adds the membership
 * probes (one per interested org); the queue list passes a shared cache so a
 * page of requests costs one probe per distinct org. An indeterminate probe
 * FAILS CLOSED.
 */
export async function conflictOfInterest(
  moderator: Caller,
  r: Req,
  publisher: Pick<Publisher, 'ownerOrgId'> | null,
  opts: { deep?: boolean; cache?: Map<string, boolean | undefined>; plugin?: PluginRow | null } = {},
): Promise<Conflict> {
  if (r.submittedBy === moderator.userId) return { conflict: true, reason: 'You submitted this request.' };
  if (r.status === 'pending_second_approval' && r.firstApprovedBy === moderator.userId) {
    return { conflict: true, reason: 'You gave the first approval; a different manager must give the second.' };
  }
  if (opts.plugin && opts.plugin.createdBy === moderator.userId) {
    return { conflict: true, reason: 'You uploaded this version.' };
  }
  if (!opts.deep) return NO_CONFLICT;
  for (const orgId of interestedOrgs(r, publisher)) {
    const key = `${orgId}:${moderator.userId}`;
    let member = opts.cache?.get(key);
    if (!opts.cache?.has(key)) {
      member = await membershipProbe(orgId, moderator.userId).catch(() => undefined);
      opts.cache?.set(key, member);
    }
    if (member === undefined) return { conflict: true, reason: 'Your membership of the requesting organization could not be verified.' };
    if (member) return { conflict: true, reason: 'You belong to the requesting organization.' };
  }
  return NO_CONFLICT;
}
