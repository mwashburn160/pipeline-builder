import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { Building2, Users, Settings } from 'lucide-react';

interface Organization {
  id: string;
  name: string;
  description?: string;
  memberCount: number;
}

export default function OrganizationsPage() {
  const { user } = useAuth();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchOrganization = async () => {
      if (user?.organizationId) {
        try {
          const response = await api.getOrganization(user.organizationId);
          if (response.success && response.data) {
            setOrganization(response.data as Organization);
          }
        } catch (error) {
          console.error('Failed to fetch organization:', error);
        }
      }
      setIsLoading(false);
    };

    fetchOrganization();
  }, [user]);

  if (isLoading) {
    return (
      <DashboardLayout>
        <Header title="Organization" description="Manage your organization" />
        <div className="p-6">
          <Card className="animate-pulse">
            <CardContent className="p-6">
              <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded" />
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  if (!organization && !user?.organizationId) {
    return (
      <DashboardLayout>
        <Header title="Organization" description="You are not part of an organization" />
        <div className="p-6">
          <Card>
            <CardContent className="p-12 text-center">
              <Building2 className="h-12 w-12 mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                No Organization
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                You are not currently part of an organization. Please wait for an invitation from an organization administrator.
              </p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <Header title="Organization" description="Manage your organization settings" />

      <div className="p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Organization Info */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Organization Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-start space-x-4">
                <div className="h-16 w-16 bg-primary-100 dark:bg-primary-900 rounded-xl flex items-center justify-center">
                  <Building2 className="h-8 w-8 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
                    {organization?.name || user?.organizationName || 'Organization'}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {organization?.description || 'No description'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card>
            <CardHeader>
              <CardTitle>Quick Stats</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <Users className="h-5 w-5 text-gray-400 mr-2" />
                    <span className="text-sm text-gray-600 dark:text-gray-400">Members</span>
                  </div>
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {organization?.memberCount || 1}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Settings */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center">
              <Settings className="h-5 w-5 mr-2" />
              Settings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Organization settings coming soon...
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
