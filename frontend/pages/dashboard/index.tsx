import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage } from '@/components/ui/Loading';
import { isSystemAdmin, isOrgAdmin } from '@/types';
import type { OrgQuotaResponse, QuotaType } from '@/types';
import api from '@/lib/api';

export default function DashboardPage() {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading: authLoading, logout } = useAuth();

  // Determine user permissions
  const isSysAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const isAdmin = isSysAdmin || isOrgAdminUser;

  useEffect(() => {
    if (isInitialized && !authLoading && !isAuthenticated) {
      router.push('/auth/login');
    }
  }, [isAuthenticated, isInitialized, authLoading, router]);

  // Fetch quota data for the widget
  const [quotaData, setQuotaData] = useState<OrgQuotaResponse | null>(null);

  const fetchQuotas = useCallback(async () => {
    try {
      const res = await api.getOwnQuotas();
      setQuotaData((res.data?.quota || res.data) as OrgQuotaResponse);
    } catch {
      // Quota service may not be reachable — widget simply won't show
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchQuotas();
  }, [isAuthenticated, fetchQuotas]);

  if (!isInitialized || authLoading) {
    return <LoadingPage message="Loading..." />;
  }

  if (!isAuthenticated || !user) {
    return <LoadingPage message="Redirecting..." />;
  }

  const navigationItems = [
    {
      title: 'Pipelines',
      description: 'Manage and monitor your data pipelines',
      href: '/dashboard/pipelines',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
        </svg>
      ),
      color: 'bg-blue-500',
    },
    {
      title: 'Plugins',
      description: 'Browse and manage available plugins',
      href: '/dashboard/plugins',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
        </svg>
      ),
      color: 'bg-purple-500',
    },
    {
      title: 'Users',
      description: 'Manage organization members and roles',
      href: '/dashboard/users',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ),
      color: 'bg-green-500',
      adminOnly: true,
    },
    {
      title: 'Organizations',
      description: 'Manage organizations and settings',
      href: '/dashboard/organizations',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      ),
      color: 'bg-yellow-500',
      systemAdminOnly: true,
    },
    {
      title: 'Quotas',
      description: 'View and manage resource quotas',
      href: '/dashboard/quotas',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
      color: 'bg-indigo-500',
    },
    {
      title: 'Settings',
      description: 'Configure your account and preferences',
      href: '/dashboard/settings',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      color: 'bg-gray-500',
    },
    {
      title: 'API Tokens',
      description: 'View JWT tokens and generate new token pairs',
      href: '/dashboard/tokens',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
      ),
      color: 'bg-teal-500',
    },
  ];

  // Filter navigation items based on user permissions
  const visibleItems = navigationItems.filter((item) => {
    if (item.systemAdminOnly && !isSysAdmin) return false;
    if (item.adminOnly && !isAdmin) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <Link href="/" className="text-xl font-bold text-blue-600 hover:text-blue-800">
              Home
            </Link>
            <span className="text-gray-300">/</span>
            <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-gray-600">
              <span className="font-medium">{user.username}</span>
              {user.organizationName && (
                <span className="text-gray-400 ml-2">({user.organizationName})</span>
              )}
            </div>
            {isSysAdmin && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                System Admin
              </span>
            )}
            {isOrgAdminUser && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                Org Admin
              </span>
            )}
            <button
              onClick={logout}
              className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome Section */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900">
            Welcome back, {user.username}!
          </h2>
          <p className="mt-1 text-gray-600">
            Here's an overview of your dashboard. Select a section to get started.
          </p>
        </div>

        {/* Navigation Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {visibleItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="group bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md hover:border-blue-300 transition-all duration-200"
            >
              <div className="flex items-start space-x-4">
                <div className={`${item.color} rounded-lg p-3 text-white group-hover:scale-110 transition-transform duration-200`}>
                  {item.icon}
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                    {item.title}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {item.description}
                  </p>
                </div>
                <svg
                  className="w-5 h-5 text-gray-400 group-hover:text-blue-500 group-hover:translate-x-1 transition-all"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          ))}
        </div>

        {/* Quota Usage + User Info */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Quota usage widget — spans 2 cols */}
          <div className="lg:col-span-2 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900">Quota Usage</h3>
              <Link
                href="/dashboard/quotas"
                className="text-xs font-medium text-blue-600 hover:text-blue-800"
              >
                Manage →
              </Link>
            </div>

            {quotaData ? (
              <div className="space-y-4">
                {(['plugins', 'pipelines', 'apiCalls'] as QuotaType[]).map((key) => {
                  const q = quotaData.quotas[key];
                  const p = q.limit <= 0 ? 0 : Math.min(100, Math.round((q.used / q.limit) * 100));
                  const pDisplay = q.unlimited ? 15 : p;
                  const barColor = q.unlimited
                    ? 'bg-blue-500'
                    : p >= 90 ? 'bg-red-500' : p >= 70 ? 'bg-yellow-500' : 'bg-green-500';
                  const labels: Record<QuotaType, string> = { plugins: 'Plugins', pipelines: 'Pipelines', apiCalls: 'API Calls' };
                  const fmt = (n: number) => n === -1 ? '∞' : n.toLocaleString();

                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="font-medium text-gray-700">{labels[key]}</span>
                        <span className="text-gray-500 tabular-nums">
                          {fmt(q.used)} / {fmt(q.limit)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
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
                  <div key={i} className="animate-pulse">
                    <div className="h-4 bg-gray-200 rounded w-1/3 mb-2" />
                    <div className="h-1.5 bg-gray-200 rounded-full" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* User info card */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">Account</h3>
            <div>
              <p className="text-xs font-medium text-gray-500">Role</p>
              <p className="text-sm font-semibold text-gray-900 capitalize">{user.role}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500">Email</p>
              <p className="text-sm text-gray-900">
                {user.isEmailVerified ? '✓ Verified' : '✗ Not Verified'}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500">Organization</p>
              <p className="text-sm font-semibold text-gray-900">
                {user.organizationName || 'None'}
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
