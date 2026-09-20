// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * audit-activity.tsx is now a redirect shim.
 *
 * The page that USED to live here was the static replacement for Grafana's
 * Explore audit-log surface. That functionality migrated to the DB-stored
 * `Audit Activity` dashboard (seeded under org_id='system'), and the
 * DB-stored renderer honours the URL-param filters (`?event=`, `?actor=`,
 * `?requestId=`) that deep-links such as `buildAuditLogLink` produce, and offers
 * a filter form for them on the dashboard itself.
 *
 * Keeping this file as a shim — rather than deleting it outright — preserves
 * existing deep-links (registry-audit-link, bookmarks) without requiring the
 * helper itself to look up the dashboard id at link-build time. One redirect
 * per click is cheap; rewriting every helper isn't.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RetryError } from '@/components/ui/RetryError';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { api } from '@/lib/api';
import { formatError } from '@/lib/constants';

/** Name of the seeded dashboard we redirect to. Matches the seeder in
 * platform/src/services/dashboard-seeder.ts. */
const TARGET_DASHBOARD_NAME = 'Audit Activity';

export default function AuditActivityRedirect() {
  // Admin-only (declared in page-access), matching the audit-log viewer at
  // /dashboard/audit. The Audit Activity panels read the MongoDB audit trail
  // scoped to the caller's org (a sysadmin sees every org), and the
  // observability API gates them `adminOnly` exactly like GET /audit — so a
  // plain member gets the access-denied state.
  const { accessDenied, isReady, isAuthenticated } = useAuthGuard();
  const router = useRouter();
  const ready = isReady && isAuthenticated;

  const { data: targetId, error, refetch } = useFetch(
    async (signal) => {
      if (!ready) return null;
      const res = await api.listDashboards(signal);
      const match = res.data?.dashboards.find((d) => d.name === TARGET_DASHBOARD_NAME);
      if (!match) {
        throw new Error(`Could not find the seeded "${TARGET_DASHBOARD_NAME}" dashboard. Has the platform service finished its cold-start seed? Check Postgres.`);
      }
      return match.id;
    },
    [ready],
  );

  useEffect(() => {
    if (!router.isReady || !targetId) return;
    // Preserve every URL param except `id` (which would conflict with the
    // dashboard route). The DB-stored renderer reads `range` and the audit
    // filters (`event`, `actor`, `requestId`) directly.
    const { id: _ignored, ...passThrough } = router.query;
    void router.replace({ pathname: `/dashboard/observability/${targetId}`, query: passThrough });
    // Capture the query at redirect time; re-renders shouldn't re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, targetId]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!ready) return <LoadingPage />;
  if (error) {
    return (
      <DashboardLayout title="Audit Activity" subtitle="">
        <RetryError message={formatError(error)} onRetry={refetch} />
        <Link href="/dashboard/observability" className="mt-4 inline-block text-brand hover:underline text-sm">← Back to all dashboards</Link>
      </DashboardLayout>
    );
  }
  return <LoadingPage />;
}
