// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Support-contact designation for an org the caller administers.
 *
 * Mounted under `/organization/:id/support-contacts`, beside the other
 * org-scoped self-serve surfaces rather than under `/admin` — designating a
 * support contact is a tenant's own decision about its own people, not an
 * operator action.
 *
 * `org:settings` is the gate on the WRITES, matching the convention that only
 * writes are capability-gated. It is the right capability rather than
 * `billing:manage` or `messages:write`: this decides which of the org's members
 * speak for it to the support desk, which is an organization setting. It is not
 * `members:manage` either — nothing here changes anybody's membership or role.
 *
 * The READ carries the SAME capability, which is the exception to "gate writes
 * only" rather than an oversight. This read is the admin panel's, and it
 * discloses the account's pooled allowance and usage — a commercial fact about
 * the whole account, including sibling teams the caller may not administer. The
 * tenant-facing list that ordinary members genuinely need (the transfer picker's
 * own-org contacts) is already served by the message service on `messages:read`,
 * so nothing is lost by keeping this one with the writes.
 */

import { audited, requirePermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  addSupportContact,
  listSupportContacts,
  removeSupportContact,
  setSupportContactLevel,
} from '../controllers/support-contacts.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

router.get('/', requireAuth, requirePermission('org:settings'), listSupportContacts);
// Both writes move a PAID allowance and change who can commit us to a response
// target, so both are audited. No step-up: this is routine administration an
// admin may do weekly, and the blast radius of a wrong designation is one
// person gaining the ability to file a case, not a key rotation.
router.post('/', requireAuth, requirePermission('org:settings'), audited('support.contact.designate'), addSupportContact);
router.delete('/:userId', requireAuth, requirePermission('org:settings'), audited('support.contact.revoke'), removeSupportContact);
// Upgrade / downgrade an existing contact to premium. A separate verb from
// designation because it answers to a different cap (`supportPremiumContacts`)
// and fails for different reasons, so collapsing the two would make one refusal
// stand for two unrelated problems. `audited()` takes the UPGRADE action; the
// controller emits the downgrade one when that is what happened.
router.patch('/:userId', requireAuth, requirePermission('org:settings'), audited('support.contact.upgrade'), setSupportContactLevel);

export default router;
