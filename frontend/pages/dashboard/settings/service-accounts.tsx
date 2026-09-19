// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization SERVICE ACCOUNTS (#2) — now the "Service accounts" tab of
 * /dashboard/security, where the org's machine identities sit beside the keys
 * they issue and the personal credentials they are constantly confused with.
 *
 * This file forwards the old address (a page moving, not a compatibility shim:
 * nothing of the old page runs behind it). The permission gate stays HERE as
 * well as on the destination, so someone without `service_accounts:manage` is
 * told why rather than bounced to a tab that won't render — and the API
 * enforces it regardless.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage } from '@/components/ui/Loading';
import { SERVICE_ACCOUNTS_HREF } from '@/lib/security-links';

export default function ServiceAccountsPageMoved() {
  const router = useRouter();
  const { accessDenied, isReady, user } = useAuthGuard({ requirePermission: 'service_accounts:manage' });

  useEffect(() => {
    if (!router.isReady || !isReady || !user || accessDenied) return;
    void router.replace(SERVICE_ACCOUNTS_HREF);
  }, [router.isReady, isReady, user, accessDenied, router]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  return <LoadingPage />;
}
