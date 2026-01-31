import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, Input, Badge } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import api, { ApiError } from '@/lib/api';
import { Search, Edit2, Trash2, X, Save, Shield } from 'lucide-react';

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [orgs, setOrgs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [form, setForm] = useState({ username: '', email: '', role: 'user', organizationId: '' });
  const [error, setError] = useState('');

  const isSystemAdmin = me?.role === 'admin' && me?.organizationName?.toLowerCase() === 'system';

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.listUsers(search ? { search } : {}) as any;
      setUsers(res.users || []);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 403) setError('Access denied');
        else setError(err.message);
      }
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [search]);
  useEffect(() => { 
    if (isSystemAdmin) api.listOrganizations().then((r: any) => setOrgs(r.organizations || [])).catch(() => {}); 
  }, [isSystemAdmin]);

  const save = async () => {
    setError('');
    try {
      await api.updateUserById(editing.id, { ...form, organizationId: form.organizationId || null });
      setEditing(null);
      load();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 403) setError('Permission denied');
        else if (err.statusCode === 409) setError('Email already in use');
        else setError(err.message);
      }
    }
  };

  const del = async () => {
    setError('');
    try {
      await api.deleteUserById(deleting.id);
      setDeleting(null);
      load();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 403) setError('Permission denied');
        else setError(err.message);
      }
    }
  };

  return (
    <DashboardLayout>
      <Header title="Users" description="Manage users" />
      <div className="p-6 space-y-4">
        {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
        
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-600" />
        </div>

        <Card>
          <CardContent className="p-4">
            {loading ? <div className="text-center py-8 text-gray-500">Loading...</div> : 
             users.length === 0 ? <div className="text-center py-8 text-gray-500">No users</div> : (
              <div className="divide-y dark:divide-gray-700">
                {users.map(u => (
                  <div key={u.id} className="flex items-center justify-between py-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{u.username}</span>
                        {u.role === 'admin' && <Shield className="h-4 w-4 text-amber-500" />}
                        {u.id === me?.id && <Badge variant="info">You</Badge>}
                      </div>
                      <div className="text-sm text-gray-500">{u.email}</div>
                      {isSystemAdmin && u.organizationName && <div className="text-xs text-gray-400">{u.organizationName}</div>}
                    </div>
                    {u.id !== me?.id && (
                      <div className="flex gap-2">
                        <button onClick={() => { setEditing(u); setForm({ username: u.username, email: u.email, role: u.role, organizationId: u.organizationId || '' }); }}
                          className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"><Edit2 className="h-4 w-4" /></button>
                        <button onClick={() => setDeleting(u)} className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 rounded text-red-600"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditing(null)}>
          <Card className="w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <CardContent className="p-6 space-y-4">
              <div className="flex justify-between items-center"><h3 className="font-semibold">Edit User</h3><button onClick={() => setEditing(null)}><X className="h-5 w-5" /></button></div>
              <Input label="Username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
              <Input label="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
              <div><label className="block text-sm font-medium mb-1">Role</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className="w-full border rounded-lg px-3 py-2 dark:bg-gray-800 dark:border-gray-600">
                  <option value="user">User</option><option value="admin">Admin</option>
                </select>
              </div>
              {isSystemAdmin && <div><label className="block text-sm font-medium mb-1">Organization</label>
                <select value={form.organizationId} onChange={e => setForm({ ...form, organizationId: e.target.value })} className="w-full border rounded-lg px-3 py-2 dark:bg-gray-800 dark:border-gray-600">
                  <option value="">None</option>{orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>}
              <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}><Save className="h-4 w-4 mr-1" />Save</Button></div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Delete Confirm */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDeleting(null)}>
          <Card className="w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <CardContent className="p-6 text-center">
              <h3 className="font-semibold mb-2">Delete User?</h3>
              <p className="text-gray-500 mb-4">Delete <strong>{deleting.username}</strong>?</p>
              <div className="flex justify-center gap-2"><Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button><Button onClick={del} className="bg-red-600 hover:bg-red-700">Delete</Button></div>
            </CardContent>
          </Card>
        </div>
      )}
    </DashboardLayout>
  );
}
