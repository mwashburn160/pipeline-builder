// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * audit-activity.tsx is now a redirect shim.
 *
 * The page that USED to live here was the static replacement for Grafana's
 * Explore audit-log surface. That functionality migrated to the DB-stored
 * `Audit Activity` dashboard (seeded under org_id='system'), and the
 * DB-stored renderer now honours the URL-param filters (`?event=`, `?actor=`,
 * `?digest=`) that `buildAuditLogLink` produces.
 *
 * Keeping this file as a shim — rather than deleting it outright — preserves
 * existing deep-links (registry-audit-link, bookmarks) without requiring the
 * helper itself to look up the dashboard id at link-build time. One redirect
 * per click is cheap; rewriting every helper isn't.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { api, ApiError } from '@/lib/api';

/** Name of the seeded dashboard we redirect to. Matches the seeder in
 * platform/src/services/dashboard-seeder.ts. */
const TARGET_DASHBOARD_NAME = 'Audit Activity';

export default function AuditActivityRedirect() {
  const { isReady, isAuthenticated } = useAuthGuard();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!router.isReady) return;
    if (!isReady || !isAuthenticated) return;
    let cancelled = false;
    // Capture query inside the effect so we don't depend on the unstable
    // `router` object — re-renders shouldn't re-trigger the redirect.
    const query = router.query;
    (async () => {
      try {
        const res = await api.listDashboards();
        const match = res.data?.dashboards.find((d) => d.name === TARGET_DASHBOARD_NAME);
        if (cancelled) return;
        if (!match) {
          setError(`Could not find the seeded "${TARGET_DASHBOARD_NAME}" dashboard. Has the platform service finished its cold-start seed? Check Postgres.`);
          return;
        }
        // Preserve every URL param except `id` (which would conflict with
        // the dashboard route). The DB-stored renderer reads `range`,
        // `event`, `actor`, `digest` directly.
        const { id: _ignored, ...passThrough } = query;
        void router.replace(
          { pathname: `/dashboard/observability/${match.id}`, query: passThrough },
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : (err as Error).message);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, isReady, isAuthenticated]);

  if (!isReady || !isAuthenticated) return <LoadingPage />;
  if (error) {
    return (      <DashboardLayout title="Audit Activity" subtitle="">
        <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
        <Link href="/dashboard/observability" className="mt-4 inline-block text-blue-600 hover:underline text-sm">← Back to all dashboards</Link>
      </DashboardLayout>
    );
  }
  return <LoadingPage />;
}
