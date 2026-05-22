// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only sysadmin platform-settings surface.
 *
 * Today the values that govern multi-tenant posture (RLS context mode,
 * per-org KMS opt-in, etc.) live in env vars baked into the deploy. This
 * page surfaces the *current* values from `/api/admin/summary` so
 * operators don't have to shell into a running container to check what
 * the deploy actually set. Editing still requires re-deploying with new
 * env vars — the page is intentionally read-only with copy-pastable
 * variable names.
 *
 * If the platform later grows runtime settings (e.g. via a settings
 * collection in Mongo), this page is the natural place to add edit
 * controls behind step-up + audit.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Shield, KeyRound, Database, Lock, AlertTriangle, RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

interface AdminSummary {
  orgs: { total: number; perOrgKms: number; ssoEnabled: number };
  users: { total: number; sysadmins: number };
  encryption: { perOrgKmsEnabled: boolean };
  rls: { contextMode: 'warn' | 'strict' | 'silent' };
}

function ModeBadge({ mode }: { mode: 'warn' | 'strict' | 'silent' }) {
  if (mode === 'strict') return <Badge color="green">strict</Badge>;
  if (mode === 'warn') return <Badge color="yellow">warn</Badge>;
  return <Badge color="gray">silent</Badge>;
}

interface SettingRow {
  icon: React.ComponentType<{ className?: string }>;
  envVar: string;
  label: string;
  currentValue: React.ReactNode;
  hint: string;
}

export default function PlatformSettingsPage() {
  const { isReady, user } = useAuthGuard({ requireSystemAdmin: true });
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getAdminSummary();
      if (res.success && res.data) setSummary(res.data);
      else setError(res.message || 'Failed to load platform settings');
    } catch (err) {
      setError(formatError(err, 'Failed to load platform settings'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isReady && user) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, user]);

  if (!isReady || !user) return <LoadingPage />;

  // Build the settings rows from the summary. Each one names the env
  // var an operator would set to change it, so the page doubles as a
  // deploy-time reference.
  const rows: SettingRow[] = summary ? [
    {
      icon: Shield,
      envVar: 'RLS_CONTEXT_MODE',
      label: 'Postgres RLS context enforcement',
      currentValue: <ModeBadge mode={summary.rls.contextMode} />,
      hint: 'strict = reject queries without tenant context; warn = log + allow; silent = do nothing. Production should be strict after log-soaking warn.',
    },
    {
      icon: KeyRound,
      envVar: 'SECRET_ENCRYPTION_PER_ORG_KMS',
      label: 'Per-org KMS opt-in',
      currentValue: summary.encryption.perOrgKmsEnabled
        ? <Badge color="green">enabled</Badge>
        : <Badge color="gray">disabled (shared master)</Badge>,
      hint: `${summary.orgs.perOrgKms} of ${summary.orgs.total} org${summary.orgs.total === 1 ? '' : 's'} have a per-org CMK bound; the rest fall back to SECRET_ENCRYPTION_KEY.`,
    },
    {
      icon: Lock,
      envVar: 'AUTH_LIMITER_MAX / WINDOWMS',
      label: 'Auth endpoint rate limit',
      currentValue: <code className="text-xs">20 req / 15 min (IP)</code>,
      hint: 'Defaults; check the platform deploy if you have overrides. The step-up endpoint additionally applies 5 req / 60s per user.',
    },
    {
      icon: Database,
      envVar: 'JWT_EXPIRES_IN',
      label: 'Access token TTL',
      currentValue: <code className="text-xs">tier-dependent</code>,
      hint: 'Resolution order: per-call override → per-tier override → global default (config.auth.jwt.expiresIn). Compliance-driven tiers can narrow the stolen-token window.',
    },
  ] : [];

  return (
    <DashboardLayout
      title="Platform settings"
      subtitle="Read-only view of deploy-time configuration"
      titleExtra={<Badge color="red">System Admin</Badge>}
      actions={
        <button onClick={() => void load()} disabled={loading} className="btn btn-secondary inline-flex items-center gap-1">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      }
    >
      <div className="mb-4">
        <Link href="/dashboard" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to admin home
        </Link>
      </div>

      {error && (
        <div className="alert-error mb-4">
          <p>{error}</p>
        </div>
      )}

      <div className="card mb-4 border-amber-200/60 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-900/20">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800 dark:text-amber-200">
            <strong>Read-only.</strong> All values reflect the running deploy&apos;s environment.
            To change a setting, edit the deploy&apos;s env vars and re-deploy — the platform reads
            these at process start.
          </div>
        </div>
      </div>

      {loading && !summary && <LoadingSpinner />}

      {summary && (
        <>
          {/* Fleet overview — quick at-a-glance counts. Sourced from the
              same admin-summary endpoint the admin home uses, just
              re-presented in the platform-settings context. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="card text-center">
              <div className="text-xs text-gray-500 dark:text-gray-400">Orgs</div>
              <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{summary.orgs.total}</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-500 dark:text-gray-400">Users</div>
              <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{summary.users.total}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{summary.users.sysadmins} sysadmin{summary.users.sysadmins === 1 ? '' : 's'}</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-500 dark:text-gray-400">Per-org KMS</div>
              <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{summary.orgs.perOrgKms}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">of {summary.orgs.total}</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-500 dark:text-gray-400">SSO enabled</div>
              <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{summary.orgs.ssoEnabled}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">of {summary.orgs.total}</div>
            </div>
          </div>

          {/* Settings table — env var, value, and a short hint each. */}
          <div className="card overflow-hidden">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Configuration</h2>
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {rows.map((row) => {
                const Icon = row.icon;
                return (
                  <li key={row.envVar} className="py-3 flex items-start gap-3">
                    <div className="flex-shrink-0 w-9 h-9 rounded-md bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                      <Icon className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{row.label}</div>
                        <div className="text-sm">{row.currentValue}</div>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">{row.envVar}</code>
                        <span>{row.hint}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
            See <code>docs/environment-variables.md</code> for the full list of platform env vars
            and their effects.
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
