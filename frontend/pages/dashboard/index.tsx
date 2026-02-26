import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Terminal } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { CopyButton } from '@/components/ui/CopyButton';
import { pct, fmtNum, barColor } from '@/lib/quota-helpers';
import type { OrgQuotaResponse, QuotaType } from '@/types';
import api from '@/lib/api';

/** Dashboard home page. Shows a welcome banner, CLI install instructions, quota usage summary, and account info. */
export default function DashboardPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();
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

  if (!isReady || !user) return null;

  const QUOTA_LABELS: Record<QuotaType, string> = { plugins: 'Plugins', pipelines: 'Pipelines', apiCalls: 'API Calls' };

  return (
    <DashboardLayout title="Dashboard">
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
          Here&apos;s an overview of your workspace.
        </p>
      </motion.div>

      {/* Pipeline Manager CLI + Quota Usage */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
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
            transition={{ duration: 0.3, delay: 0.15 }}
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
            transition={{ duration: 0.3, delay: 0.2 }}
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
    </DashboardLayout>
  );
}
