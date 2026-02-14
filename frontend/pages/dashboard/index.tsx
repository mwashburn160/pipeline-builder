import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Sun, Moon, GitBranch, Puzzle, Users, Building2, BarChart3, Settings, KeyRound, ChevronRight, Terminal, ScrollText, Activity, FileSearch } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDarkMode } from '@/hooks/useDarkMode';
import { LoadingPage } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import { pct, fmtNum, barColor } from '@/lib/quota-helpers';
import type { OrgQuotaResponse, QuotaType } from '@/types';
import api from '@/lib/api';

const navItems = [
  { title: 'Pipelines', description: 'Manage and monitor your data pipelines', href: '/dashboard/pipelines', icon: GitBranch, color: 'bg-blue-500' },
  { title: 'Plugins', description: 'Browse and manage available plugins', href: '/dashboard/plugins', icon: Puzzle, color: 'bg-purple-500' },
  { title: 'Users', description: 'Manage organization members and roles', href: '/dashboard/users', icon: Users, color: 'bg-green-500', adminOnly: true },
  { title: 'Organizations', description: 'Manage organizations and settings', href: '/dashboard/organizations', icon: Building2, color: 'bg-yellow-500', systemAdminOnly: true },
  { title: 'Logs', description: 'View service logs and search across microservices', href: '/dashboard/logs', icon: ScrollText, color: 'bg-cyan-500' },
  { title: 'Loki Logging', description: 'Search and explore application logs via Loki', href: '/dashboard/loki', icon: FileSearch, color: 'bg-rose-500' },
  { title: 'Grafana', description: 'View service metrics, logs, and dashboards', href: '/dashboard/grafana', icon: Activity, color: 'bg-orange-500', systemAdminOnly: true },
  { title: 'Quotas', description: 'View and manage resource quotas', href: '/dashboard/quotas', icon: BarChart3, color: 'bg-indigo-500' },
  { title: 'Settings', description: 'Configure your account and preferences', href: '/dashboard/settings', icon: Settings, color: 'bg-gray-500' },
  { title: 'API Tokens', description: 'View JWT tokens and generate new token pairs', href: '/dashboard/tokens', icon: KeyRound, color: 'bg-teal-500' },
];

export default function DashboardPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin, logout } = useAuthGuard();
  const { isDark, toggle } = useDarkMode();
  const [quotaData, setQuotaData] = useState<OrgQuotaResponse | null>(null);

  const fetchQuotas = useCallback(async () => {
    try {
      const res = await api.getOwnQuotas();
      setQuotaData((res.data?.quota || res.data) as OrgQuotaResponse);
    } catch {
      // Quota service may not be reachable
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchQuotas();
  }, [isAuthenticated, fetchQuotas]);

  if (!isReady || !user) return <LoadingPage />;

  const visibleItems = navItems.filter((item) => {
    if ('systemAdminOnly' in item && item.systemAdminOnly && !isSysAdmin) return false;
    if ('adminOnly' in item && item.adminOnly && !isAdmin) return false;
    return true;
  });

  const QUOTA_LABELS: Record<QuotaType, string> = { plugins: 'Plugins', pipelines: 'Pipelines', apiCalls: 'API Calls' };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <header className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm shadow dark:shadow-gray-900/30 border-b border-gray-200/60 dark:border-gray-700/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <Link href="/" className="text-xl font-bold text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors">
              Home
            </Link>
            <span className="text-gray-300 dark:text-gray-600">/</span>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Dashboard</h1>
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium text-gray-900 dark:text-gray-200">{user.username}</span>
              {user.organizationName && (
                <span className="text-gray-400 dark:text-gray-500 ml-2">({user.organizationName})</span>
              )}
            </div>
            {isSysAdmin && <Badge color="red">System Admin</Badge>}
            {isOrgAdminUser && <Badge color="blue">Org Admin</Badge>}
            <button
              onClick={toggle}
              className="p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label="Toggle dark mode"
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={logout}
              className="btn btn-secondary text-sm py-1.5"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8"
        >
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Welcome back, {user.username}!
          </h2>
          <p className="mt-1 text-gray-600 dark:text-gray-400">
            Here&apos;s an overview of your dashboard. Select a section to get started.
          </p>
        </motion.div>

        {/* Navigation Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {visibleItems.map((item, i) => {
            const Icon = item.icon;
            return (
              <motion.div
                key={item.href}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.05 }}
              >
                <Link
                  href={item.href}
                  className="group card block hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.06)] dark:hover:shadow-[0_4px_12px_rgba(0,0,0,0.3),0_12px_40px_rgba(0,0,0,0.2)] hover:border-blue-300 dark:hover:border-blue-700 transition-all duration-200"
                >
                  <div className="flex items-start space-x-4">
                    <div className={`${item.color} rounded-xl p-3 text-white group-hover:scale-110 transition-transform duration-200`}>
                      <Icon className="w-8 h-8" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        {item.description}
                      </p>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-400 dark:text-gray-500 group-hover:text-blue-500 group-hover:translate-x-1 transition-all" />
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>

        {/* Pipeline Manager CLI + Quota Usage */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.3 }}
            className="card"
          >
            <div className="flex items-start space-x-4 mb-4">
              <div className="bg-cyan-500 rounded-xl p-3 text-white">
                <Terminal className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Pipeline Manager CLI</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">Manage pipelines and plugins from the command line</p>
              </div>
            </div>

            <div className="mb-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Prerequisites</p>
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">Node.js &gt;= 24.9.0</span>
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">AWS CLI configured</span>
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">AWS CDK &gt;= 2.237.0</span>
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">PLATFORM_TOKEN env var</span>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Install</p>
                <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 rounded-lg px-4 py-2.5 font-mono text-sm text-gray-800 dark:text-gray-200">
                  <code>npm install -g @mwashburn160/pipeline-manager</code>
                  <CopyButton text="npm install -g @mwashburn160/pipeline-manager" />
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Verify</p>
                <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 rounded-lg px-4 py-2.5 font-mono text-sm text-gray-800 dark:text-gray-200">
                  <code>pipeline-manager version</code>
                  <CopyButton text="pipeline-manager version" />
                </div>
              </div>
            </div>
          </motion.div>

          <div className="flex flex-col gap-6">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.35 }}
              className="card"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Quota Usage</h3>
                <Link href="/dashboard/quotas" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
                  Manage →
                </Link>
              </div>

              {quotaData ? (
                <div className="space-y-4">
                  {(['plugins', 'pipelines', 'apiCalls'] as QuotaType[]).map((key) => {
                    const q = quotaData.quotas[key];
                    const p = pct(q.used, q.limit);
                    const pDisplay = q.unlimited ? 15 : p;
                    const color = barColor(q.used, q.limit, q.unlimited);

                    return (
                      <div key={key}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="font-medium text-gray-700 dark:text-gray-300">{QUOTA_LABELS[key]}</span>
                          <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                            {fmtNum(q.used)} / {fmtNum(q.limit)}
                          </span>
                        </div>
                        <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${color}`}
                            style={{ width: `${pDisplay}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-4">
                  {[0, 1, 2].map((i) => (
                    <div key={i}>
                      <div className="h-4 skeleton w-1/3 mb-2" />
                      <div className="h-1.5 skeleton rounded-full" />
                    </div>
                  ))}
                </div>
              )}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.4 }}
              className="card space-y-4"
            >
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Account</h3>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Role</p>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 capitalize">{user.role}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Email</p>
                <p className="text-sm text-gray-900 dark:text-gray-100">
                  {user.isEmailVerified ? 'Verified' : 'Not Verified'}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Organization</p>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {user.organizationName || 'None'}
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}
