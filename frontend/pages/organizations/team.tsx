import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input } from '@/components/ui';
import api from '@/lib/api';
import { Invitation } from '@/types';
import { UserPlus, Mail, Clock, X, Check } from 'lucide-react';
import { formatDate } from '@/lib/utils';

export default function TeamPage() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'user' | 'admin'>('user');
  const [isInviting, setIsInviting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchInvitations = async () => {
    try {
      setIsLoading(true);
      const response = await api.getInvitations();
      if (response.success) {
        setInvitations((response as { invitations?: Invitation[] }).invitations || []);
      }
    } catch (error) {
      console.error('Failed to fetch invitations:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchInvitations();
  }, []);

  const handleInvite = async () => {
    if (!inviteEmail) {
      setError('Email is required');
      return;
    }

    setIsInviting(true);
    setError('');
    setSuccess('');

    try {
      await api.createInvitation(inviteEmail, inviteRole);
      setSuccess('Invitation sent successfully!');
      setShowInvite(false);
      setInviteEmail('');
      setInviteRole('user');
      fetchInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setIsInviting(false);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.cancelInvitation(id);
      fetchInvitations();
    } catch (error) {
      console.error('Failed to cancel invitation:', error);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="warning">Pending</Badge>;
      case 'accepted':
        return <Badge variant="success">Accepted</Badge>;
      case 'expired':
        return <Badge variant="danger">Expired</Badge>;
      case 'cancelled':
        return <Badge variant="default">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <DashboardLayout>
      <Header title="Team" description="Manage your team members and invitations" />

      <div className="p-6">
        {/* Success Message */}
        {success && (
          <div className="mb-6 p-4 text-sm text-green-600 bg-green-50 dark:bg-green-900/20 rounded-lg flex items-center">
            <Check className="h-5 w-5 mr-2" />
            {success}
          </div>
        )}

        {/* Invite Button */}
        <div className="flex justify-end mb-6">
          <Button onClick={() => setShowInvite(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            Invite Member
          </Button>
        </div>

        {/* Invite Modal */}
        {showInvite && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card className="w-full max-w-md mx-4">
              <CardContent className="p-6">
                <h3 className="text-lg font-semibold mb-4">Invite Team Member</h3>
                
                {error && (
                  <div className="mb-4 p-3 text-sm text-red-600 bg-red-50 rounded-lg">
                    {error}
                  </div>
                )}

                <div className="space-y-4">
                  <Input
                    label="Email Address"
                    type="email"
                    placeholder="colleague@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Role
                    </label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as 'user' | 'admin')}
                      className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-gray-900 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end gap-3 mt-6">
                  <Button variant="secondary" onClick={() => {
                    setShowInvite(false);
                    setError('');
                  }}>
                    Cancel
                  </Button>
                  <Button onClick={handleInvite} isLoading={isInviting}>
                    Send Invitation
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Invitations List */}
        <Card>
          <CardHeader>
            <CardTitle>Invitations</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="animate-pulse flex items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                    <div className="flex items-center space-x-4">
                      <div className="h-10 w-10 bg-gray-200 dark:bg-gray-700 rounded-full" />
                      <div>
                        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-32 mb-2" />
                        <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-24" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : invitations.length === 0 ? (
              <div className="text-center py-8">
                <Mail className="h-12 w-12 mx-auto text-gray-400 mb-3" />
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  No invitations yet. Invite team members to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {invitations.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg"
                  >
                    <div className="flex items-center space-x-4">
                      <div className="h-10 w-10 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
                        <Mail className="h-5 w-5 text-gray-400" />
                      </div>
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">
                          {invitation.email}
                        </p>
                        <div className="flex items-center space-x-2 mt-1">
                          <Badge variant="info">{invitation.role}</Badge>
                          {getStatusBadge(invitation.status)}
                          <span className="text-xs text-gray-400 flex items-center">
                            <Clock className="h-3 w-3 mr-1" />
                            Expires {formatDate(invitation.expiresAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                    {invitation.status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCancel(invitation.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
