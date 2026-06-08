// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operations-focused home view for sysadmins.
 *
 * Rendered from `/dashboard` when the caller is a sysadmin (see
 * pages/dashboard/index.tsx role switcher).
 *
 * Three rows:
 *   1. Fleet stats (orgs, users, KMS adoption, SSO)
 *   2. Multi-tenant posture + recent audit feed (side by side)
 *   3. Quick-links into the sysadmin surfaces (deeper drill-down)
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Building2, Users, KeyRound, ShieldCheck, Activity, AlertTriangle, History,
} from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { CopyableId } from '@/components/ui/CopyableId';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';

interface AdminSummary {
  orgs: { total: number; perOrgKms: number; ssoEnabled: number };
  users: { total: number; sysadmins: number };
  encryption: { perOrgKmsEnabled: boolean };
  rls: { contextMode: 'warn' | 'strict' | 'silent' };
}

interface AuditEvent {
  _id: string;
  action: string;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}

function StatCard({
  icon: Icon, label, value, sub, href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  href?: string;
}) {
  const inner = (
    <div className="card hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors h-full">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-gray-500" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export function SysadminHome() {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Two independent fetches in parallel. Each tolerates the other's
  // failure — if the audit feed is down, the fleet stats still render.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      api.getAdminSummary(),
      api.listAuditEvents({ limit: 5 }),
    ]).then(([summaryRes, auditRes]) => {
      if (cancelled) return;
      if (summaryRes.status === 'fulfilled' && summaryRes.value.success && summaryRes.value.data) {
        setSummary(summaryRes.value.data);
      } else if (summaryRes.status === 'fulfilled') {
        setError(summaryRes.value.message || 'Failed to load summary');
      } else {
        setError(formatError(summaryRes.reason, 'Failed to load summary'));
      }
      if (auditRes.status === 'fulfilled' && auditRes.value.success && auditRes.value.data) {
        setEvents(auditRes.value.data.events);
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      {error && (
        <div className="alert-error mb-4">
          <p>{error}</p>
        </div>
      )}

      {loading && !summary && <LoadingSpinner />}

      {summary && (
        <>
          {/* Fleet stats — single row, clickable cards drill into the
              respective management surfaces. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard
              icon={Building2}
              label="Organizations"
              value={summary.orgs.total}
              href="/dashboard/organizations"
            />
            <StatCard
              icon={Users}
              label="Users"
              value={summary.users.total}
              sub={`${summary.users.sysadmins} sysadmin${summary.users.sysadmins === 1 ? '' : 's'}`}
              href="/dashboard/users"
            />
            <StatCard
              icon={KeyRound}
              label="Per-org KMS"
              value={
                <span>
                  {summary.orgs.perOrgKms}
                  <span className="text-base font-normal text-gray-500 dark:text-gray-400"> / {summary.orgs.total}</span>
                </span>
              }
              sub={summary.encryption.perOrgKmsEnabled
                ? 'enabled at process level'
                : <span className="text-amber-600 dark:text-amber-400">opt-in disabled</span>}
            />
            <StatCard
              icon={ShieldCheck}
              label="SSO enabled"
              value={
                <span>
                  {summary.orgs.ssoEnabled}
                  <span className="text-base font-normal text-gray-500 dark:text-gray-400"> / {summary.orgs.total}</span>
                </span>
              }
              sub="orgs with active IdP config"
            />
          </div>

          {/* Posture + recent activity side-by-side */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
            <div className="card lg:col-span-1">
              <div className="flex items-center gap-2 mb-3">
                <Activity className="w-4 h-4 text-gray-500" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Multi-tenant posture</h3>
              </div>
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between rounded-md bg-gray-50 dark:bg-gray-800/50 px-2.5 py-1.5">
                  <dt className="text-gray-700 dark:text-gray-300">RLS context</dt>
                  <dd>
                    {summary.rls.contextMode === 'strict'
                      ? <Badge color="green">strict</Badge>
                      : summary.rls.contextMode === 'warn'
                        ? <Badge color="yellow">warn</Badge>
                        : <Badge color="gray">{summary.rls.contextMode}</Badge>}
                  </dd>
                </div>
                <div className="flex items-center justify-between rounded-md bg-gray-50 dark:bg-gray-800/50 px-2.5 py-1.5">
                  <dt className="text-gray-700 dark:text-gray-300">Per-org KMS</dt>
                  <dd>
                    {summary.encryption.perOrgKmsEnabled
                      ? <Badge color="green">active</Badge>
                      : <Badge color="gray">shared master</Badge>}
                  </dd>
                </div>
              </dl>

              {summary.rls.contextMode !== 'strict' && (
                <div className="mt-3 flex gap-2 rounded-md bg-amber-50 dark:bg-amber-900/20 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" />
                  <div>
                    RLS is in <code>{summary.rls.contextMode}</code>. Production should run in
                    {' '}<code>strict</code> after a clean warn-mode log-soak.
                  </div>
                </div>
              )}

              <Link href="/dashboard/admin/platform-settings" className="action-link text-xs mt-3 inline-flex">
                Platform settings →
              </Link>
            </div>

            <div className="card lg:col-span-2">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
                  <History className="w-4 h-4 text-gray-400" />
                  Recent fleet activity
                </h3>
                <Link href="/dashboard/audit" className="action-link text-xs">View all →</Link>
              </div>
              {events.length === 0 ? (
                <div className="text-xs text-gray-500 dark:text-gray-400 py-3">
                  No audit events recorded yet.
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {events.map((e) => (
                    <li key={e._id} className="py-1.5 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <code className="text-xs font-medium text-blue-700 dark:text-blue-300">{e.action}</code>
                        <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          <RelativeTime value={e.createdAt} />
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-2">
                        <span>by <code>{e.actorEmail || e.actorId}</code></span>
                        {e.affectedOrgId && (
                          <span className="inline-flex items-center gap-1">
                            affected: <CopyableId value={e.affectedOrgId} size="sm" />
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Quick-links */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Platform surfaces</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <Link href="/dashboard/organizations" className="action-link">Organizations</Link>
              <Link href="/dashboard/users" className="action-link">All users</Link>
              <Link href="/dashboard/audit" className="action-link">Audit log</Link>
              <Link href="/dashboard/quotas" className="action-link">Quotas</Link>
              <Link href="/dashboard/registry" className="action-link">Image registry</Link>
              <Link href="/dashboard/triage" className="action-link">Build triage</Link>
              <Link href="/dashboard/observability/alert-destinations?all=1" className="action-link">Alert destinations</Link>
              <Link href="/dashboard/admin/platform-settings" className="action-link">Platform settings</Link>
            </div>
          </div>
        </>
      )}
    </>
  );
}
