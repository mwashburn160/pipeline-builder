// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { ShieldOff } from 'lucide-react';
import type { AccessDenial } from '@/hooks/useAuthGuard';

/**
 * The single "you don't have access to this page" state.
 *
 * Rendered in place of the page body when `useAuthGuard().accessDenied` is set —
 * a deep link, a bookmark or a post-login redirect to a route the viewer can't
 * read. It replaces two older behaviours, both dishonest in their own way: the
 * full dashboard chrome followed by one failed panel per fetch, and the silent
 * `router.push('/dashboard')` that made a shared link look broken.
 *
 * It says WHAT is missing (the permission id, or the admin scope) and what to do
 * about it, because the person hitting this is usually a colleague who was sent
 * the link and needs to know exactly what to ask for.
 *
 * Full-screen (no `DashboardLayout`), matching `LoadingPage` — the page never
 * got far enough to own the chrome, and rendering the sidebar around a refusal
 * invites the "click around until something loads" loop this exists to end.
 */
export function AccessDenied({ denial }: { denial: AccessDenial }) {
  const requirement = denial.kind === 'systemAdmin'
    ? 'system administrator access'
    : 'organization admin or owner access';

  const remedy = denial.kind === 'systemAdmin'
    ? 'This is a Pipeline Builder operator surface. If you need it, ask an operator — an org role can\'t grant it.'
    : 'Ask an owner or admin of your organization to grant it, then reload this page.';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div
        data-testid="access-denied"
        role="alert"
        className="max-w-md w-full rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900"
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 dark:bg-gray-800">
          <ShieldOff className="h-7 w-7 text-fg-subtle" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
          You don&apos;t have access to this page
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">{denial.pathname}</code>
          {' '}requires {denial.kind === 'permission' ? <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">{denial.permission}</code> : requirement}
          {denial.kind === 'permission' ? ' in your active organization.' : '.'}
        </p>
        <p className="mt-2 text-sm text-fg-muted">{remedy}</p>
        <Link href="/dashboard" className="btn btn-primary btn-sm mt-5 inline-flex">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
