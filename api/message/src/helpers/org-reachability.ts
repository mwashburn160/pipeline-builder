// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createLogger,
  errorMessage,
  fetchOrgMembership,
  fetchParentOrgId,
  resolveRootOrgIdWith,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('org-reachability');

// Send-reachability for message creation. A member may only start a
// conversation with an org they could also *receive* from — mirroring the
// read-visibility model in `buildMessageConditions`. That means the recipient
// must be one of:
//   - the caller's OWN org (they'd see the thread as the sender);
//   - the SYSTEM support org (the support channel — always reachable);
//   - an org inside the caller's ACCOUNT (same root org → team hierarchy).
//
// The "same account" test resolves each side's root org (walking `parentOrgId`
// up via platform's authoritative `GET /organization/:id/parent`) and compares:
// two orgs are in the same account iff they share a root. This is SYMMETRIC —
// exactly "an org you could also receive from". Orgs are flat today
// (`parentOrgId` null on every row), so each root resolves to itself and the
// account collapses to `{self}` — i.e. cross-org sends are closed until orgs
// actually get parents, which is the intended default-closed posture.
//
// The HTTP mechanics (URL, signed service-token auth, timeout+retry) live in
// the shared api-core helper; this module only supplies the message service's
// fallback policy. A hierarchy-resolution failure FAILS CLOSED (deny) — a
// cross-tenant send is never allowed to slip through on a transport error.

/** Build the platform org-hierarchy HTTP options for the message service. */
function hierarchyOptions() {
  const { services } = Config.get('server');
  return {
    service: { host: services.platformHost, port: services.platformPort },
    serviceName: 'message',
    // System-scoped service token: the lookup is a read of the org tree, not a
    // tenant-scoped operation. Never carries an AWS account id.
    authOrgId: SYSTEM_ORG_ID,
  } as const;
}

/** Walk `parentOrgId` up to the account root via platform (cycle-safe, depth-capped). */
function resolveRootOrgId(orgId: string): Promise<string> {
  return resolveRootOrgIdWith(orgId, (id) => fetchParentOrgId(id, hierarchyOptions()));
}

/**
 * True when a member of `callerOrgId` is allowed to send a conversation to
 * `recipientOrgId`. Allowed IFF the recipient is the caller's own org, the
 * system support org, or within the caller's account (shared root org).
 *
 * Own-org and system-org are decided WITHOUT any network call. A cross-org
 * recipient triggers the two root resolutions; any lookup failure denies
 * (fail-closed) so a transport error can't open a cross-tenant injection path.
 */
export async function isRecipientReachable(callerOrgId: string, recipientOrgId: string): Promise<boolean> {
  const caller = callerOrgId.toLowerCase();
  const recipient = recipientOrgId.toLowerCase();

  // Fast paths that need no hierarchy lookup.
  if (recipient === caller) return true;
  if (recipient === SYSTEM_ORG_ID.toLowerCase()) return true;

  try {
    const [callerRoot, recipientRoot] = await Promise.all([
      resolveRootOrgId(caller),
      resolveRootOrgId(recipient),
    ]);
    return callerRoot.toLowerCase() === recipientRoot.toLowerCase();
  } catch (err) {
    logger.warn('Recipient reachability lookup failed; denying cross-org recipient', {
      callerOrgId: caller,
      recipientOrgId: recipient,
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * True when `userId` may be the per-user target of a DM to `recipientOrgId` —
 * i.e. platform does NOT definitively report them a non-member. A targeted
 * message to someone outside the recipient org would black-hole (viewer-scoping
 * means nobody in that org is scoped to see it), so this rejects the obvious
 * mistake up front.
 *
 * FAIL-OPEN (unlike {@link isRecipientReachable}, which is a security gate and
 * fails closed): this is a correctness/UX guard, not an authorization boundary —
 * the recipient still can't read a message they're not scoped for. So only a
 * DEFINITIVE not-a-member (`fetchOrgMembership` → `false`) blocks; an
 * indeterminate result (`undefined`) or a transport error ALLOWS the send rather
 * than coupling message delivery to platform availability.
 */
export async function isTargetUserReachable(recipientOrgId: string, userId: string): Promise<boolean> {
  try {
    const isMember = await fetchOrgMembership(recipientOrgId.toLowerCase(), userId, hierarchyOptions());
    if (isMember === false) return false; // definitive: not a member
    return true; // member, or indeterminate → fail-open
  } catch (err) {
    logger.warn('Target-user membership lookup failed; allowing send (fail-open)', {
      recipientOrgId: recipientOrgId.toLowerCase(),
      userId,
      error: errorMessage(err),
    });
    return true;
  }
}
