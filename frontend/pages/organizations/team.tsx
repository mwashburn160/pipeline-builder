import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Badge } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import api, { ApiError } from '@/lib/api';
import { UserPlus, Mail, Crown, Shield, X, Clock } from 'lucide-react';
import { formatDate } from '@/lib/utils';

export default function TeamPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'members' | 'invites'>('members');
  const [members, setMembers] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState('');

  const isAdmin = user?.role === 'admin';
  const isOwner = user?.id === ownerId;

  const load = async () => {
    if (!user?.organizationId) return;
    setLoading(true);
    setError('');
    try {
      const [m, i] = await Promise.all([
        api.getOrganizationMembers(user.organizationId) as any,
        api.getInvitations() as any
      ]);
      setMembers(m.members || []);
      setOwnerId(m.ownerId || '');
      setInvites(i.invitations || []);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) setError('Access denied');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [user?.organizationId]);

  const invite = async () => {
    setError('');
    try {
      await api.createInvitation(email, role);
      setShowInvite(false);
      setEmail('');
      load();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409) setError('User already invited or member');
        else if (err.statusCode === 403) setError('Permission denied');
        else setError(err.message);
      }
    }
  };

  const cancelInvite = async (id: string) => {
    try { await api.cancelInvitation(id); load(); } catch {}
  };

  const changeRole = async (userId: string, newRole: 'user' | 'admin') => {
    setError('');
    try {
      await api.updateMemberRole(user!.organizationId!, userId, newRole);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) setError('Cannot change role');
    }
  };

  const remove = async (userId: string) => {
    if (!confirm('Remove this member?')) return;
    setError('');
    try {
      await api.removeMemberFromOrganization(user!.organizationId!, userId);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) setError('Cannot remove member');
    }
  };

  const transfer = async (userId: string) => {
    if (!confirm('Transfer ownership? You will become admin.')) return;
    setError('');
    try {
      await api.transferOrganizationOwnership(user!.organizationId!, userId);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) setError('Only owner can transfer');
    }
  };

  return (
    <DashboardLayout>
      <Header title="Team" description="Manage members and invitations" />
      <div className="p-6">
        {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
        
        <div className="flex justify-between mb-4">
          <div className="flex gap-2">
            <button onClick={() => setTab('members')} className={`px-4 py-2 rounded-lg ${tab === 'members' ? 'bg-primary-100 text-primary-700' : ''}`}>Members ({members.length})</button>
            <button onClick={() => setTab('invites')} className={`px-4 py-2 rounded-lg ${tab === 'invites' ? 'bg-primary-100 text-primary-700' : ''}`}>Invitations</button>
          </div>
          {isAdmin && <Button onClick={() => setShowInvite(true)}><UserPlus className="h-4 w-4 mr-1" />Invite</Button>}
        </div>

        <Card>
          <CardContent className="p-4">
            {loading ? <div className="text-center py-8 text-gray-500">Loading...</div> : tab === 'members' ? (
              <div className="divide-y dark:divide-gray-700">
                {members.map(m => (
                  <div key={m.id} className="flex items-center justify-between py-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{m.username}</span>
                        {m.isOwner && <Crown className="h-4 w-4 text-amber-500" />}
                        {m.role === 'admin' && !m.isOwner && <Shield className="h-4 w-4 text-amber-500" />}
                        {m.id === user?.id && <Badge variant="info">You</Badge>}
                      </div>
                      <div className="text-sm text-gray-500">{m.email}</div>
                    </div>
                    {isAdmin && m.id !== user?.id && !m.isOwner && (
                      <div className="flex items-center gap-2">
                        <select value={m.role} onChange={e => changeRole(m.id, e.target.value as any)} className="text-sm border rounded px-2 py-1 dark:bg-gray-800">
                          <option value="user">User</option><option value="admin">Admin</option>
                        </select>
                        {isOwner && <button onClick={() => transfer(m.id)} className="text-xs text-blue-600 hover:underline">Transfer</button>}
                        <button onClick={() => remove(m.id)} className="text-red-600 text-sm">Remove</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : invites.length === 0 ? <div className="text-center py-8 text-gray-500">No invitations</div> : (
              <div className="divide-y dark:divide-gray-700">
                {invites.map(inv => (
                  <div key={inv.id} className="flex items-center justify-between py-3">
                    <div>
                      <div className="font-medium">{inv.email}</div>
                      <div className="flex items-center gap-2 text-sm text-gray-500">
                        <Badge variant={inv.status === 'pending' ? 'warning' : inv.status === 'accepted' ? 'success' : 'default'}>{inv.status}</Badge>
                        <span><Clock className="h-3 w-3 inline" /> {formatDate(inv.expiresAt)}</span>
                      </div>
                    </div>
                    {inv.status === 'pending' && isAdmin && <button onClick={() => cancelInvite(inv.id)} className="text-red-600"><X className="h-4 w-4" /></button>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Invite Modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowInvite(false)}>
          <Card className="w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold">Send Invitation</h3>
              <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
              <div><label className="block text-sm font-medium mb-1">Role</label>
                <select value={role} onChange={e => setRole(e.target.value as any)} className="w-full border rounded-lg px-3 py-2 dark:bg-gray-800">
                  <option value="user">User</option><option value="admin">Admin</option>
                </select>
              </div>
              <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setShowInvite(false)}>Cancel</Button><Button onClick={invite}>Send</Button></div>
            </CardContent>
          </Card>
        </div>
      )}
    </DashboardLayout>
  );
}
