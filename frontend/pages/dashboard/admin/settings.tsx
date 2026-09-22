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

import Link from 'next/link';
import { ArrowLeft, Shield, KeyRound, Database, Lock, AlertTriangle, RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RetryError } from '@/components/ui/RetryError';
import api from '@/lib/api';
import { AdminConsoleLinks } from '@/components/admin/AdminConsoleLinks';
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
  /** True when `currentValue` is a built-in default hardcoded here, NOT a value
   *  read from `/api/admin/summary`. Rendered with a "default" badge so an
   *  operator never mistakes a static constant for the running deploy's config. */
  staticDefault?: boolean;
}

export default function PlatformSettingsPage() {
  // The sysadmin gate comes from the nav entry (`systemAdminOnly`) via page-access.
  const { accessDenied, isReady, user } = useAuthGuard();
  const read = useFetch(async (signal): Promise<AdminSummary | null> => {
    if (!isReady || !user) return null;
    const res = await api.getAdminSummary({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load platform settings');
    return res.data;
  }, [isReady, user?.id]);
  const summary = read.data;
  const loading = read.loading;
  const load = read.refetch;

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
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
      staticDefault: true,
      hint: 'Built-in default shown for reference — NOT read from the running deploy, so an override in this env var will not be reflected here. The step-up endpoint additionally applies 5 req / 60s per user.',
    },
    {
      icon: Database,
      envVar: 'JWT_EXPIRES_IN',
      label: 'Access token TTL',
      currentValue: <code className="text-xs">tier-dependent</code>,
      staticDefault: true,
      hint: 'Built-in default shown for reference — NOT read from the running deploy. Resolution order: per-call override → per-tier override → global default (config.auth.jwt.expiresIn). Compliance-driven tiers can narrow the stolen-token window.',
    },
  ] : [];

  return (
    <DashboardLayout
      title="Platform settings"
      subtitle="Read-only view of deploy-time configuration"
      titleExtra={<Badge color="red">System Admin</Badge>}
      actions={
        <Button variant="secondary" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      }
    >
      <div className="mb-4">
        <Link href="/dashboard" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to admin home
        </Link>
      </div>

      {read.error && (
        <RetryError className="mb-4" message={formatError(read.error, 'Failed to load platform settings')} onRetry={load} />
      )}

      <Card className="mb-4 border-amber-200/60 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-900/20">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
          <div className="text-sm text-warning-strong">
            <strong>Read-only.</strong> All values reflect the running deploy&apos;s environment.
            To change a setting, edit the deploy&apos;s env vars and re-deploy — the platform reads
            these at process start.
          </div>
        </div>
      </Card>

      {/* The operator consoles (AWS gateway only) — each opens behind the
          gateway's sysadmin + AAL2 check. */}
      {user && <div className="mb-4"><AdminConsoleLinks user={user} /></div>}

      {loading && !summary && <LoadingSpinner />}

      {summary && (
        <>
          {/* Fleet overview — quick at-a-glance counts. Sourced from the
              same admin-summary endpoint the admin home uses, just
              re-presented in the platform-settings context. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Card className="text-center">
              <div className="text-xs text-fg-muted">Orgs</div>
              <div className="text-2xl font-semibold text-fg">{summary.orgs.total}</div>
            </Card>
            <Card className="text-center">
              <div className="text-xs text-fg-muted">Users</div>
              <div className="text-2xl font-semibold text-fg">{summary.users.total}</div>
              <div className="text-xs text-fg-muted">{summary.users.sysadmins} sysadmin{summary.users.sysadmins === 1 ? '' : 's'}</div>
            </Card>
            <Card className="text-center">
              <div className="text-xs text-fg-muted">Per-org KMS</div>
              <div className="text-2xl font-semibold text-fg">{summary.orgs.perOrgKms}</div>
              <div className="text-xs text-fg-muted">of {summary.orgs.total}</div>
            </Card>
            <Card className="text-center">
              <div className="text-xs text-fg-muted">SSO enabled</div>
              <div className="text-2xl font-semibold text-fg">{summary.orgs.ssoEnabled}</div>
              <div className="text-xs text-fg-muted">of {summary.orgs.total}</div>
            </Card>
          </div>

          {/* Settings table — env var, value, and a short hint each. */}
          <Card className="overflow-hidden">
            <h2 className="text-base font-semibold text-fg mb-3">Configuration</h2>
            <ul className="divide-y divide-default">
              {rows.map((row) => {
                const Icon = row.icon;
                return (
                  <li key={row.envVar} className="py-3 flex items-start gap-3">
                    <div className="flex-shrink-0 w-9 h-9 rounded-md bg-surface-muted flex items-center justify-center">
                      <Icon className="w-4 h-4 text-fg-muted" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-sm font-medium text-fg">{row.label}</div>
                        <div className="text-sm flex items-center gap-1.5">
                          {row.staticDefault && <Badge color="gray">default</Badge>}
                          {row.currentValue}
                        </div>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-xs text-fg-muted">
                        <code className="bg-surface-muted px-1.5 py-0.5 rounded">{row.envVar}</code>
                        <span>{row.hint}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="mt-4 text-xs text-fg-muted">
            See <code>docs/environment-variables.md</code> for the full list of platform env vars
            and their effects.
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
