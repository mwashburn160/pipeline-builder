import { useState, useEffect } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { User, Lock, Bell, Palette, Gauge } from 'lucide-react';
import api from '@/lib/api';

interface QuotaLimits {
  plugins: { used: number; limit: number };
  pipelines: { used: number; limit: number };
  apiCalls?: { used: number; limit: number };
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('profile');
  const [quotas, setQuotas] = useState<QuotaLimits | null>(null);
  const [quotasLoading, setQuotasLoading] = useState(false);

  const isAdmin = user?.role === 'admin';

  const tabs = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'security', label: 'Security', icon: Lock },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    ...(isAdmin ? [{ id: 'quotas', label: 'Quotas', icon: Gauge }] : []),
  ];

  useEffect(() => {
    if (activeTab === 'quotas' && isAdmin) {
      fetchQuotas();
    }
  }, [activeTab, isAdmin]);

  const fetchQuotas = async () => {
    setQuotasLoading(true);
    try {
      const response = await api.getQuotas();
      const data = response as any;
      setQuotas(data.quotas || data);
    } catch (error) {
      console.error('Failed to fetch quotas:', error);
      // Set default quotas for display
      setQuotas({
        plugins: { used: 0, limit: 100 },
        pipelines: { used: 0, limit: 50 },
        apiCalls: { used: 0, limit: 10000 },
      });
    } finally {
      setQuotasLoading(false);
    }
  };

  const getUsagePercentage = (used: number, limit: number) => {
    return Math.min((used / limit) * 100, 100);
  };

  const getUsageColor = (percentage: number) => {
    if (percentage >= 90) return 'bg-red-500';
    if (percentage >= 70) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return (
    <DashboardLayout>
      <Header title="Settings" description="Manage your account settings" />

      <div className="p-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Sidebar */}
          <div className="lg:w-64">
            <Card>
              <CardContent className="p-2">
                <nav className="space-y-1">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                        activeTab === tab.id
                          ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400'
                          : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'
                      }`}
                    >
                      <tab.icon className="h-5 w-5 mr-3" />
                      {tab.label}
                    </button>
                  ))}
                </nav>
              </CardContent>
            </Card>
          </div>

          {/* Content */}
          <div className="flex-1">
            {activeTab === 'profile' && (
              <Card>
                <CardHeader>
                  <CardTitle>Profile Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex items-center space-x-4">
                    <div className="h-20 w-20 bg-primary-100 dark:bg-primary-900 rounded-full flex items-center justify-center">
                      <span className="text-2xl font-bold text-primary-600 dark:text-primary-400">
                        {user?.username?.charAt(0).toUpperCase() || 'U'}
                      </span>
                    </div>
                    <div>
                      <Button variant="secondary" size="sm">
                        Change Avatar
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Input
                      label="Username"
                      value={user?.username || ''}
                      disabled
                    />
                    <Input
                      label="Email"
                      type="email"
                      value={user?.email || ''}
                      disabled
                    />
                  </div>

                  <div className="flex justify-end">
                    <Button>Save Changes</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'security' && (
              <Card>
                <CardHeader>
                  <CardTitle>Security Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-4">
                      Change Password
                    </h4>
                    <div className="space-y-4 max-w-md">
                      <Input
                        label="Current Password"
                        type="password"
                        placeholder="••••••••"
                      />
                      <Input
                        label="New Password"
                        type="password"
                        placeholder="••••••••"
                      />
                      <Input
                        label="Confirm New Password"
                        type="password"
                        placeholder="••••••••"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button>Update Password</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'notifications' && (
              <Card>
                <CardHeader>
                  <CardTitle>Notification Preferences</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {[
                      { label: 'Email notifications', description: 'Receive email updates about your account' },
                      { label: 'Pipeline alerts', description: 'Get notified when pipelines complete or fail' },
                      { label: 'Team invitations', description: 'Receive notifications for team invites' },
                    ].map((item, index) => (
                      <div key={index} className="flex items-center justify-between py-3 border-b border-gray-200 dark:border-gray-700 last:border-0">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">
                            {item.label}
                          </p>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {item.description}
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" className="sr-only peer" defaultChecked />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary-600"></div>
                        </label>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'appearance' && (
              <Card>
                <CardHeader>
                  <CardTitle>Appearance Settings</CardTitle>
                </CardHeader>
                <CardContent>
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-4">
                      Theme
                    </h4>
                    <div className="grid grid-cols-3 gap-4 max-w-md">
                      {['Light', 'Dark', 'System'].map((theme) => (
                        <button
                          key={theme}
                          className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg text-center hover:border-primary-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
                        >
                          <div className={`h-8 w-8 mx-auto mb-2 rounded-full ${
                            theme === 'Light' ? 'bg-white border border-gray-200' :
                            theme === 'Dark' ? 'bg-gray-900' : 'bg-gradient-to-r from-white to-gray-900'
                          }`} />
                          <span className="text-sm font-medium text-gray-900 dark:text-white">
                            {theme}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'quotas' && isAdmin && (
              <Card>
                <CardHeader>
                  <CardTitle>Organization Quota Limits</CardTitle>
                </CardHeader>
                <CardContent>
                  {quotasLoading ? (
                    <div className="space-y-4">
                      {[...Array(4)].map((_, i) => (
                        <div key={i} className="animate-pulse">
                          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4 mb-2" />
                          <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-full" />
                        </div>
                      ))}
                    </div>
                  ) : quotas ? (
                    <div className="space-y-6">
                      {/* Plugins Quota */}
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Plugins
                          </span>
                          <span className="text-sm text-gray-500 dark:text-gray-400">
                            {quotas.plugins.used} / {quotas.plugins.limit}
                          </span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                          <div
                            className={`h-2.5 rounded-full ${getUsageColor(getUsagePercentage(quotas.plugins.used, quotas.plugins.limit))}`}
                            style={{ width: `${getUsagePercentage(quotas.plugins.used, quotas.plugins.limit)}%` }}
                          />
                        </div>
                      </div>

                      {/* Pipelines Quota */}
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Pipelines
                          </span>
                          <span className="text-sm text-gray-500 dark:text-gray-400">
                            {quotas.pipelines.used} / {quotas.pipelines.limit}
                          </span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                          <div
                            className={`h-2.5 rounded-full ${getUsageColor(getUsagePercentage(quotas.pipelines.used, quotas.pipelines.limit))}`}
                            style={{ width: `${getUsagePercentage(quotas.pipelines.used, quotas.pipelines.limit)}%` }}
                          />
                        </div>
                      </div>

                      {/* API Calls Quota */}
                      {quotas.apiCalls && (
                        <div>
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                              API Calls (monthly)
                            </span>
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              {quotas.apiCalls.used.toLocaleString()} / {quotas.apiCalls.limit.toLocaleString()}
                            </span>
                          </div>
                          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                            <div
                              className={`h-2.5 rounded-full ${getUsageColor(getUsagePercentage(quotas.apiCalls.used, quotas.apiCalls.limit))}`}
                              style={{ width: `${getUsagePercentage(quotas.apiCalls.used, quotas.apiCalls.limit)}%` }}
                            />
                          </div>
                        </div>
                      )}

                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
                        Contact support to increase your quota limits.
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Unable to load quota information.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
