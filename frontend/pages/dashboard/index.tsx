import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle, Button, Input } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { Puzzle, GitBranch, Users, Activity, Building2 } from 'lucide-react';

interface Stats {
  plugins: number;
  pipelines: number;
  teamMembers: number;
}

export default function DashboardPage() {
  const { user, refreshUser } = useAuth();
  const [stats, setStats] = useState<Stats>({ plugins: 0, pipelines: 0, teamMembers: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgDescription, setOrgDescription] = useState('');
  const [isCreatingOrg, setIsCreatingOrg] = useState(false);
  const [orgError, setOrgError] = useState('');

  const hasOrganization = !!api.getOrganizationId();
  
  console.log('[Dashboard] hasOrganization:', hasOrganization, 'orgId:', api.getOrganizationId());

  useEffect(() => {
    const fetchStats = async () => {
      if (!hasOrganization) {
        setIsLoading(false);
        return;
      }
      
      try {
        const [pluginsRes, pipelinesRes] = await Promise.all([
          api.getPlugins({ limit: '1' }).catch(() => ({ total: 0 })),
          api.getPipelines({ limit: '1' }).catch(() => ({ total: 0 })),
        ]);

        setStats({
          plugins: (pluginsRes as { total?: number }).total || 0,
          pipelines: (pipelinesRes as { total?: number }).total || 0,
          teamMembers: 1,
        });
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, [hasOrganization]);

  const handleCreateOrg = async () => {
    if (!orgName.trim()) {
      setOrgError('Organization name is required');
      return;
    }

    setIsCreatingOrg(true);
    setOrgError('');

    try {
      const response = await api.createOrganization(orgName, orgDescription);
      if (response.success) {
        // Refresh user to get new organization ID
        await refreshUser();
        setShowCreateOrg(false);
        setOrgName('');
        setOrgDescription('');
        // Reload to get new token with org ID
        window.location.reload();
      } else {
        setOrgError(response.message || 'Failed to create organization');
      }
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : 'Failed to create organization');
    } finally {
      setIsCreatingOrg(false);
    }
  };

  const statCards = [
    { name: 'Total Plugins', value: stats.plugins, icon: Puzzle, color: 'text-blue-600' },
    { name: 'Total Pipelines', value: stats.pipelines, icon: GitBranch, color: 'text-green-600' },
    { name: 'Team Members', value: stats.teamMembers, icon: Users, color: 'text-purple-600' },
    { name: 'API Requests', value: '—', icon: Activity, color: 'text-orange-600' },
  ];

  // Show create organization prompt if user has no organization
  if (!hasOrganization) {
    return (
      <DashboardLayout>
        <Header 
          title={`Welcome, ${user?.username || 'User'}`} 
          description="Let's get you set up with an organization."
        />

        <div className="p-6">
          <Card className="max-w-lg mx-auto">
            <CardContent className="p-8 text-center">
              <Building2 className="h-16 w-16 mx-auto text-gray-400 mb-4" />
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                Create Your Organization
              </h3>
              <p className="text-gray-500 dark:text-gray-400 mb-6">
                You need an organization to manage plugins, pipelines, and team members.
              </p>

              {!showCreateOrg ? (
                <Button onClick={() => setShowCreateOrg(true)} size="lg">
                  <Building2 className="h-5 w-5 mr-2" />
                  Create Organization
                </Button>
              ) : (
                <div className="text-left space-y-4">
                  {orgError && (
                    <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg">
                      {orgError}
                    </div>
                  )}
                  
                  <Input
                    label="Organization Name"
                    placeholder="My Company"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                  />
                  
                  <Input
                    label="Description (optional)"
                    placeholder="A brief description of your organization"
                    value={orgDescription}
                    onChange={(e) => setOrgDescription(e.target.value)}
                  />

                  <div className="flex gap-3">
                    <Button 
                      variant="secondary" 
                      onClick={() => setShowCreateOrg(false)}
                      className="flex-1"
                    >
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleCreateOrg} 
                      isLoading={isCreatingOrg}
                      className="flex-1"
                    >
                      Create
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <Header 
        title={`Welcome back, ${user?.username || 'User'}`} 
        description="Here's what's happening with your platform today."
      />

      <div className="p-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {statCards.map((stat) => (
            <Card key={stat.name}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                      {stat.name}
                    </p>
                    <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                      {isLoading ? '—' : stat.value}
                    </p>
                  </div>
                  <div className={`p-3 rounded-lg bg-gray-100 dark:bg-gray-800 ${stat.color}`}>
                    <stat.icon className="h-6 w-6" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <a
                  href="/plugins"
                  className="flex items-center p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <Puzzle className="h-5 w-5 text-blue-600 mr-3" />
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Upload a new plugin
                  </span>
                </a>
                <a
                  href="/pipelines"
                  className="flex items-center p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <GitBranch className="h-5 w-5 text-green-600 mr-3" />
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Create a new pipeline
                  </span>
                </a>
                <a
                  href="/organizations/team"
                  className="flex items-center p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <Users className="h-5 w-5 text-purple-600 mr-3" />
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Invite team members
                  </span>
                </a>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <Activity className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No recent activity</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
