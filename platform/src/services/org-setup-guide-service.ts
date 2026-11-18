// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org "setup guide" flag: whether an org admin has dismissed the one-time
 * "finish setting up your org" guide (install the CLI, store tokens, set up
 * events). A UI preference, not a control — see controllers/org-setup-guide.ts.
 *
 * Stored as `Organization.setupGuideDismissedAt` / `setupGuideDismissedBy`,
 * set and cleared as a pair; absent means the guide is still offered.
 */

import { Types } from 'mongoose';
import { toOrgId } from '../helpers/org-id.js';
import { Organization } from '../models/index.js';

/** What `GET`/`PATCH /organization/:id/setup-guide` answer with. */
export interface SetupGuideView {
  /** ISO timestamp of the dismissal, or null while the guide is still offered. */
  dismissedAt: string | null;
  /** Id of the user who dismissed it, or null. */
  dismissedBy: string | null;
  /** True for a root organization (no `parentOrgId`); false for a team. */
  topLevel: boolean;
}

interface StoredSetupGuide {
  setupGuideDismissedAt?: Date | null;
  setupGuideDismissedBy?: Types.ObjectId | null;
  parentOrgId?: string | null;
}

function toView(doc: StoredSetupGuide): SetupGuideView {
  const at = doc.setupGuideDismissedAt ? new Date(doc.setupGuideDismissedAt) : null;
  return {
    dismissedAt: at ? at.toISOString() : null,
    dismissedBy: at && doc.setupGuideDismissedBy ? String(doc.setupGuideDismissedBy) : null,
    topLevel: !doc.parentOrgId,
  };
}

/** The org's setup-guide state, or null when the org does not exist. */
export async function readSetupGuide(orgId: string): Promise<SetupGuideView | null> {
  const doc = await Organization.findById(toOrgId(orgId))
    .select('setupGuideDismissedAt setupGuideDismissedBy parentOrgId')
    .lean<StoredSetupGuide>();
  return doc ? toView(doc) : null;
}

/**
 * Record (`dismissed: true`) or clear (`false`) the dismissal.
 *
 * Dismissing is idempotent: the write only matches an org with no dismissal
 * yet (`{ field: null }` matches absent too), so a second dismiss — or two
 * admins racing — keeps the FIRST timestamp and actor. Clearing removes both
 * fields, which re-arms the guide.
 */
export async function writeSetupGuide(orgId: string, dismissed: boolean, userId: string): Promise<SetupGuideView | null> {
  const _id = toOrgId(orgId);
  if (dismissed) {
    await Organization.updateOne(
      { _id, setupGuideDismissedAt: null },
      {
        $set: {
          setupGuideDismissedAt: new Date(),
          // User ids are ObjectIds; a principal whose `sub` is not one still
          // dismisses, it just isn't recorded as the actor.
          ...(Types.ObjectId.isValid(userId) ? { setupGuideDismissedBy: new Types.ObjectId(userId) } : {}),
        },
      },
    );
  } else {
    await Organization.updateOne({ _id }, { $unset: { setupGuideDismissedAt: '', setupGuideDismissedBy: '' } });
  }
  return readSetupGuide(orgId);
}
