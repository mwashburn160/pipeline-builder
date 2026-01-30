import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Badge } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { Building2, Users, Settings, Edit, X, Save, Search } from 'lucide-react';
import { formatDate } from '@/lib/utils';

interface Organization {
  id: string;
  name: string;
  description?: string;
  memberCount: number;
  ownerId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export default function OrganizationsPage() {
  const { user } = useAuth();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [allOrganizations, setAllOrganizations] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', description: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const isSystemAdmin = user?.role === 'admin' && user?.organizationId === 'system';

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        if (isSystemAdmin) {
          // Fetch all organizations for system admin
          const response = await api.listOrganizations();
          const data = response as any;
          setAllOrganizations(data.organizations || data.data || []);
        } else if (user?.organizationId) {
          // Fetch user's organization
          const response = await api.getOrganization(user.organizationId);
          if (response.success && response.data) {
            setOrganization(response.data as Organization);
          }
        }
      } catch (error) {
        console.error('Failed to fetch organization(s):', error);
      }
      setIsLoading(false);
    };

    fetchData();
  }, [user, isSystemAdmin]);

  const handleEditOrg = (org: Organization) => {
    setSelectedOrg(org);
    setEditForm({ name: org.name, description: org.description || '' });
    setIsEditing(true);
    setSaveError('');
  };

  const handleSaveOrg = async () => {
    if (!selectedOrg) return;

    setIsSaving(true);
    setSaveError('');

    try {
      await api.updateOrganization(selectedOrg.id, {
        name: editForm.name,
        description: editForm.description,
      });

      // Update local state
      setAllOrganizations(prev =>
        prev.map(org =>
          org.id === selectedOrg.id
            ? { ...org, name: editForm.name, description: editForm.description }
            : org
        )
      );
      setSelectedOrg({ ...selectedOrg, name: editForm.name, description: editForm.description });
      setIsEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setSaveError('');
    if (selectedOrg) {
      setEditForm({ name: selectedOrg.name, description: selectedOrg.description || '' });
    }
  };

  const filteredOrganizations = allOrganizations.filter(org =>
    org.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isLoading) {
    return (
      <DashboardLayout>
        <Header title="Organizations" description="Manage organizations" />
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

  // System Admin View - All Organizations
  if (isSystemAdmin) {
    return (
      <DashboardLayout>
        <Header title="Organizations" description="Manage all organizations (System Admin)" />

        <div className="p-6">
          {/* Search */}
          <div className="mb-6">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input
                type="search"
                placeholder="Search organizations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          <div className="flex gap-6">
            {/* Organizations List */}
            <div className={`${selectedOrg ? 'flex-1' : 'w-full'}`}>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredOrganizations.map((org) => (
                  <Card
                    key={org.id}
                    className={`cursor-pointer hover:shadow-md transition-shadow ${
                      selectedOrg?.id === org.id ? 'ring-2 ring-primary-500' : ''
                    }`}
                    onClick={() => {
                      setSelectedOrg(selectedOrg?.id === org.id ? null : org);
                      setIsEditing(false);
                      setSaveError('');
                    }}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center">
                          <div className="h-10 w-10 bg-primary-100 dark:bg-primary-900 rounded-lg flex items-center justify-center mr-3">
                            <Building2 className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                          </div>
                          <div>
                            <h3 className="font-semibold text-gray-900 dark:text-white">
                              {org.name}
                            </h3>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {org.memberCount || 0} members
                            </p>
                          </div>
                        </div>
                        {org.name.toLowerCase() === 'system' && (
                          <Badge variant="warning">System</Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {filteredOrganizations.length === 0 && (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Building2 className="h-12 w-12 mx-auto text-gray-400 mb-4" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      No organizations found
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Organization Detail Panel */}
            {selectedOrg && (
              <div className="w-96 flex-shrink-0">
                <Card className="sticky top-6">
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between mb-6">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                        Organization Details
                      </h3>
                      <div className="flex items-center gap-2">
                        {!isEditing && (
                          <button
                            onClick={() => handleEditOrg(selectedOrg)}
                            className="p-1 text-gray-400 hover:text-primary-600"
                            title="Edit"
                          >
                            <Edit className="h-5 w-5" />
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setSelectedOrg(null);
                            setIsEditing(false);
                          }}
                          className="p-1 text-gray-400 hover:text-gray-600"
                        >
                          <X className="h-5 w-5" />
                        </button>
                      </div>
                    </div>

                    {saveError && (
                      <div className="mb-4 p-3 text-sm text-red-600 bg-red-50 rounded-lg">
                        {saveError}
                      </div>
                    )}

                    {isEditing ? (
                      <div className="space-y-4">
                        <Input
                          label="Name"
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        />
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Description
                          </label>
                          <textarea
                            value={editForm.description}
                            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                            rows={3}
                            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button onClick={handleSaveOrg} isLoading={isSaving}>
                            <Save className="h-4 w-4 mr-2" />
                            Save
                          </Button>
                          <Button variant="secondary" onClick={handleCancelEdit}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex items-center mb-4">
                          <div className="h-12 w-12 bg-primary-100 dark:bg-primary-900 rounded-lg flex items-center justify-center mr-4">
                            <Building2 className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                          </div>
                          <div>
                            <h4 className="font-semibold text-gray-900 dark:text-white">
                              {selectedOrg.name}
                            </h4>
                            {selectedOrg.name.toLowerCase() === 'system' && (
                              <Badge variant="warning">System Organization</Badge>
                            )}
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            ID
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white font-mono break-all">
                            {selectedOrg.id}
                          </p>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Description
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {selectedOrg.description || 'No description'}
                          </p>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Members
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {selectedOrg.memberCount || 0}
                          </p>
                        </div>

                        {selectedOrg.createdAt && (
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                              Created At
                            </label>
                            <p className="text-sm text-gray-900 dark:text-white">
                              {formatDate(selectedOrg.createdAt)}
                            </p>
                          </div>
                        )}

                        {selectedOrg.updatedAt && (
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                              Updated At
                            </label>
                            <p className="text-sm text-gray-900 dark:text-white">
                              {formatDate(selectedOrg.updatedAt)}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  // Regular User View - Own Organization Only
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
