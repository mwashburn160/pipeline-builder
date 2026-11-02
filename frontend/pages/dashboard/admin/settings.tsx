// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sysadmin platform surface, in four tabs.
 *
 * - **Configuration** — the values that govern multi-tenant posture (RLS context
 *   mode, per-org KMS opt-in, …) live in env vars baked into the deploy, so this
 *   reads the CURRENT ones from `/api/admin/summary` and nobody has to shell
 *   into a running container to check what the deploy actually set. Read-only by
 *   design, with copy-pastable variable names; changing one means a re-deploy.
 * - **Posture** — fleet counts plus the on-call paging posture.
 * - **Consoles** — the five operator consoles behind the gateway.
 * - **Staffing** — who holds each of the system org's job Roles. The one tab
 *   that WRITES, and the only grant path for a system-org-only permission.
 *
 * It was one column until the last two arrived, at which point finding the
 * rosters meant scrolling past four unrelated surfaces. The tabs also fixed a
 * real defect: Consoles and Staffing had been nested inside the summary fetch's
 * guard, so a slow or failed `GET /admin/summary` hid them both.
 */

import Link from 'next/link';
import { ArrowLeft, Shield, KeyRound, Database, Lock, AlertTriangle, RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useUrlTab } from '@/hooks/useUrlTab';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RetryError } from '@/components/ui/RetryError';
import api from '@/lib/api';
import { AdminConsoleLinks } from '@/components/admin/AdminConsoleLinks';
import { OnCallPagingPanel } from '@/components/admin/OnCallPagingPanel';
import { PlatformStaffingPanel } from '@/components/admin/PlatformStaffingPanel';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { formatError } from '@/lib/constants';

/** Tab/panel id pair prefix, so a screen reader can jump from tab to panel. */
const TAB_PREFIX = 'platform-settings';

const SETTINGS_TABS = [
  { id: 'config', label: 'Configuration' },
  { id: 'posture', label: 'Posture' },
  { id: 'consoles', label: 'Consoles' },
  { id: 'staffing', label: 'Staffing' },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];
const SETTINGS_TAB_IDS = SETTINGS_TABS.map((t) => t.id);

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
  const { accessDenied, isReady, user, can, isSuperAdmin, isReadOnly } = useAuthGuard();
  // In the URL, so "look at Platform settings → Staffing" is a link rather than
  // an instruction, and a refresh does not drop you back on Configuration.
  const [tab, setTab] = useUrlTab<SettingsTab>('tab', SETTINGS_TAB_IDS, 'config');
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
  // NESTED reads are each guarded. The `summary ?` test below proves only that
  // the object arrived — a response missing `rls` or `encryption` (an older
  // platform, a narrowed payload) used to throw inside render and white-screen
  // the entire settings page, taking the other sections with it. A missing value
  // reads as an em dash, which is honest: the page's job is to report what the
  // deploy set, and "we could not read it" is a real answer.
  const rows: SettingRow[] = summary ? [
    {
      icon: Shield,
      envVar: 'RLS_CONTEXT_MODE',
      label: 'Postgres RLS context enforcement',
      currentValue: summary.rls ? <ModeBadge mode={summary.rls.contextMode} /> : <span className="text-fg-muted">—</span>,
      hint: 'strict = reject queries without tenant context; warn = log + allow; silent = do nothing. Production should be strict after log-soaking warn.',
    },
    {
      icon: KeyRound,
      envVar: 'SECRET_ENCRYPTION_PER_ORG_KMS',
      label: 'Per-org KMS opt-in',
      currentValue: summary.encryption?.perOrgKmsEnabled
        ? <Badge color="green">enabled</Badge>
        : <Badge color="gray">disabled (shared master)</Badge>,
      hint: `${summary.orgs?.perOrgKms ?? 0} of ${summary.orgs?.total ?? 0} org${summary.orgs?.total === 1 ? '' : 's'} have a per-org CMK bound; the rest fall back to SECRET_ENCRYPTION_KEY.`,
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

  /**
   * FOUR TABS, not one scroll.
   *
   * The page had grown to six stacked surfaces — a read-only banner, five
   * console tiles, four fleet counters, the env table, the on-call posture and
   * four role rosters — which is three different jobs in one column: what this
   * deploy is CONFIGURED to do, whether it is HEALTHY, and who is ALLOWED to do
   * what. Finding the staffing rosters meant scrolling past everything else.
   *
   * `requires` is a permission the tab's content needs. Filtered on HELD
   * permissions rather than `can()`, the same rule the Ecosystem console uses: a
   * read-only impersonation session should still SEE a tab whose writes are
   * disabled, and `can()` returns false for a write-class permission there.
   */
  const activeTab: SettingsTab = tab;

  return (
    <DashboardLayout
      title="Platform settings"
      subtitle="Deploy-time configuration, posture, consoles and staffing"
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

      <TabBar
        items={SETTINGS_TABS.map(({ id, label }) => ({ id, label }))}
        activeId={activeTab}
        onSelect={(id) => setTab(id as SettingsTab)}
        idPrefix={TAB_PREFIX}
        ariaLabel="Platform settings sections"
        className="mb-4"
      />

      {/* The summary fetch backs the Configuration and Posture tabs only, so its
          failure is reported there rather than at the top of a page whose other
          two tabs do not use it. */}
      {read.error && activeTab !== 'consoles' && activeTab !== 'staffing' && (
        <RetryError className="mb-4" message={formatError(read.error, 'Failed to load platform settings')} onRetry={load} />
      )}

      <div {...tabPanelProps(TAB_PREFIX, activeTab)}>
        {activeTab === 'config' && (
          <>
            <Card className="mb-4 border-amber-200/60 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-900/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
                <div className="text-sm text-warning-strong">
                  <strong>Read-only.</strong> These values reflect the running deploy&apos;s environment.
                  To change one, edit the deploy&apos;s env vars and re-deploy — the platform reads
                  them at process start. (The <strong>Staffing</strong> tab is the exception: it writes.)
                </div>
              </div>
            </Card>

            {loading && !summary && <LoadingSpinner />}

            {summary && (
              <>
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
          </>
        )}

        {activeTab === 'posture' && (
          <>
            {loading && !summary && <LoadingSpinner />}
            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <Card className="text-center">
                  <div className="text-xs text-fg-muted">Orgs</div>
                  <div className="text-2xl font-semibold text-fg">{summary.orgs?.total ?? 0}</div>
                </Card>
                <Card className="text-center">
                  <div className="text-xs text-fg-muted">Users</div>
                  <div className="text-2xl font-semibold text-fg">{summary.users?.total ?? 0}</div>
                  <div className="text-xs text-fg-muted">{summary.users?.sysadmins ?? 0} sysadmin{summary.users?.sysadmins === 1 ? '' : 's'}</div>
                </Card>
                <Card className="text-center">
                  <div className="text-xs text-fg-muted">Per-org KMS</div>
                  <div className="text-2xl font-semibold text-fg">{summary.orgs?.perOrgKms ?? 0}</div>
                  <div className="text-xs text-fg-muted">of {summary.orgs?.total ?? 0}</div>
                </Card>
                <Card className="text-center">
                  <div className="text-xs text-fg-muted">SSO enabled</div>
                  <div className="text-2xl font-semibold text-fg">{summary.orgs?.ssoEnabled ?? 0}</div>
                  <div className="text-xs text-fg-muted">of {summary.orgs?.total ?? 0}</div>
                </Card>
              </div>
            )}
            {/* Fetches its own posture, so it renders whether or not the summary
                landed — which is why it is not inside the `summary` guard. */}
            <OnCallPagingPanel canManage={can('oncall:manage')} />
          </>
        )}

        {/* Neither of the last two tabs depends on the summary fetch. They used
            to sit inside its guard, which meant a slow or failed
            `GET /admin/summary` hid the ONLY surface that assigns the job Roles. */}
        {activeTab === 'consoles' && user && <AdminConsoleLinks user={user} />}

        {activeTab === 'staffing' && (
          <PlatformStaffingPanel isSuperAdmin={isSuperAdmin} canWrite={!isReadOnly} />
        )}
      </div>
    </DashboardLayout>
  );
}
