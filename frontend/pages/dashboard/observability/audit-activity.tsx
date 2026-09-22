// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolver for the stable "Audit activity" address.
 *
 * The audit view is the DB-stored `Audit activity` dashboard seeded under
 * org_id='system', whose id is generated at seed time — so no link can name it
 * statically. Links (the nav entry, `buildAuditLogLink`) point here instead;
 * this page looks the dashboard up by name and replaces itself with it,
 * passing the audit filters (`?event=`, `?actor=`, `?requestId=`, `?range=`)
 * through, which the dashboard renderer reads directly.
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
const TARGET_DASHBOARD_NAME = 'Audit activity';

export default function AuditActivityResolver() {
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
      const res = await api.listDashboards({ signal });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the query is captured at redirect time; re-renders must not re-trigger it
  }, [router.isReady, targetId]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!ready) return <LoadingPage />;
  if (error) {
    return (
      <DashboardLayout title="Audit activity" subtitle="">
        <RetryError message={formatError(error)} onRetry={refetch} />
        <Link href="/dashboard/observability" className="mt-4 inline-block text-brand hover:underline text-sm">← Back to all dashboards</Link>
      </DashboardLayout>
    );
  }
  return <LoadingPage />;
}
