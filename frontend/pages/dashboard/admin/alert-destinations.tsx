// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Redirect shim.
 *
 * The cross-tenant alert-destinations viewer that used to live here is now the
 * "All organizations" mode of the single destinations page
 * (`/dashboard/observability/alert-destinations`), so org admins and sysadmins
 * manage/inspect destinations in one place instead of three. This shim keeps
 * old deep-links and bookmarks working.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { LoadingPage } from '@/components/ui/Loading';
import { useAuthGuard } from '@/hooks/useAuthGuard';

export default function AdminAlertDestinationsRedirect() {
  // NOT `requireSystemAdmin` — this is a redirect shim, not the sysadmin surface.
  // Gating it sysadmin-only stranded non-sysadmins here: the guard's `isReady`
  // never became true for them, so the `router.replace` below never fired and they
  // sat on <LoadingPage> until the guard bounced them to /dashboard — losing the
  // destinations page they can legitimately view. Now everyone is routed onward.
  const { isReady, isAuthenticated, isSuperAdmin } = useAuthGuard();
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady || !isReady || !isAuthenticated) return;
    // Sysadmins land in the cross-tenant "all organizations" mode; everyone else
    // gets their own org's destinations (the ?all=1 mode is sysadmin-only).
    void router.replace(
      isSuperAdmin
        ? '/dashboard/observability/alert-destinations?all=1'
        : '/dashboard/observability/alert-destinations',
    );
  }, [router, router.isReady, isReady, isAuthenticated, isSuperAdmin]);

  return <LoadingPage />;
}
