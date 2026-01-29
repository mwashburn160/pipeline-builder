import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { Puzzle, GitBranch, Users, Activity } from 'lucide-react';

interface Stats {
  plugins: number;
  pipelines: number;
  teamMembers: number;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats>({ plugins: 0, pipelines: 0, teamMembers: 0 });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
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
  }, []);

  const statCards = [
    { name: 'Total Plugins', value: stats.plugins, icon: Puzzle, color: 'text-blue-600' },
    { name: 'Total Pipelines', value: stats.pipelines, icon: GitBranch, color: 'text-green-600' },
    { name: 'Team Members', value: stats.teamMembers, icon: Users, color: 'text-purple-600' },
    { name: 'API Requests', value: '—', icon: Activity, color: 'text-orange-600' },
  ];

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
