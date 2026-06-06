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
  const { isReady, isAuthenticated } = useAuthGuard({ requireSystemAdmin: true });
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady || !isReady || !isAuthenticated) return;
    void router.replace('/dashboard/observability/alert-destinations?all=1');
  }, [router, router.isReady, isReady, isAuthenticated]);

  return <LoadingPage />;
}
