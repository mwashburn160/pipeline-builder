// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { OrgSetupStep } from '@/components/onboarding/OrgSetupStep';
import { isSystemOrgActive } from '@/lib/ecosystem-access';
import { isEnrolmentPendingSession } from '@/lib/enrolment-session';
import { isSetupGuideSnoozed, snoozeSetupGuide } from '@/lib/setup-guide';
import type { User } from '@/types';

/**
 * Whether this session may be offered the popup at all, before any read.
 *
 * - An admin of the ACTIVE org, by a real grant: `org_settings:write` in the
 *   profile's permissions. Not `hasPermission`, which is true for a superadmin
 *   in every org — an operator switching into a customer org must not be asked
 *   to set it up (or be able to dismiss it for the customer).
 * - Not the system org: it is the platform's own, not a customer deployment.
 * - Not a read-only impersonation (it can't write the dismissal), and not an
 *   enrolment-limited session (it may only finish enrolling a factor).
 */
export function mayOfferSetupGuide(user: Pick<User, 'organizationId' | 'permissions'> | null | undefined): boolean {
  if (!user?.organizationId) return false;
  if (isSystemOrgActive(user)) return false;
  if (!user.permissions?.includes('org_settings:write')) return false;
  if (api.isImpersonating()) return false;
  if (isEnrolmentPendingSession()) return false;
  return true;
}

/**
 * The one-time "finish setting up your organization" popup, for org admins on
 * any dashboard page — whichever way the org was created (email/password
 * sign-up, a skipped social onboarding, an org created for them).
 *
 * SHOWN ONCE PER ORG, decided on the server: "Done — don't show again" records
 * the dismissal on the org (`PATCH /organization/:id/setup-guide`), so another
 * admin, browser or device doesn't see it again. Teams never get it (they share
 * the parent's setup — `topLevel: false`).
 *
 * "Remind me later" (and the X / Escape) hold it off on this browser for a day,
 * and the guide stays on the Downloads page either way. The guide shows live
 * progress, so an admin can tell whether the steps actually worked before saying
 * they're done.
 */
export function SetupGuidePopup({ user }: { user: User | null }) {
  // Browser state (impersonation marker, storage) — after mount only.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [closed, setClosed] = useState(false);

  const orgId = user?.organizationId ?? '';
  const eligible = mounted && mayOfferSetupGuide(user) && !isSetupGuideSnoozed(orgId);
  const state = useFetch(
    async (signal) => (await api.getSetupGuide(orgId, { signal })).data ?? null,
    [orgId],
    { enabled: eligible },
  );

  // A new active org is a new question.
  useEffect(() => { setClosed(false); }, [orgId]);

  if (!eligible || closed) return null;
  const s = state.data;
  // A failed read means silence, not a popup: it returns on the next load.
  if (!s || state.error || s.dismissedAt || !s.topLevel) return null;

  const later = () => { snoozeSetupGuide(orgId); setClosed(true); };
  const done = () => {
    setClosed(true);
    // A failed write is deliberately silent: the popup is gone for this page
    // view and returns on a later load — the safe direction to fail in.
    void api.updateSetupGuide(orgId, { dismissed: true }).catch(() => undefined);
  };

  return (
    <Modal title="Finish setting up your organization" onClose={later} maxWidth="max-w-lg" tall>
      <OrgSetupStep
        variant="modal"
        status={{ orgId, user }}
        doneLabel="Done — don't show again"
        onDone={done}
        secondaryAction={<Button variant="secondary" onClick={later} className="w-full sm:w-auto">Remind me later</Button>}
      />
    </Modal>
  );
}
