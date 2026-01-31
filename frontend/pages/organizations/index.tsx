import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Badge } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { Building2, Users, Search, Edit, X, Save, Gauge, Clock, Infinity } from 'lucide-react';
import { formatDate } from '@/lib/utils';

function QuotaBar({ label, used, limit, resetAt }: { label: string; used: number; limit: number; resetAt?: string }) {
  const unlimited = limit === -1;
  const pct = unlimited ? 0 : Math.min((used / limit) * 100, 100);
  const color = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-yellow-500' : 'bg-green-500';
  const resetIn = resetAt ? Math.max(0, Math.floor((new Date(resetAt).getTime() - Date.now()) / 86400000)) : null;

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span>{used} / {unlimited ? <Infinity className="inline h-3 w-3" /> : limit}</span>
      </div>
      <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full">
        <div className={`h-full rounded-full ${unlimited ? 'bg-green-300 w-full opacity-30' : color}`} style={unlimited ? {} : { width: `${pct}%` }} />
      </div>
      {resetIn !== null && <div className="text-xs text-gray-400"><Clock className="h-3 w-3 inline" /> {resetIn}d</div>}
    </div>
  );
}

export default function OrganizationsPage() {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });

  const isSystemAdmin = user?.role === 'admin' && user?.organizationName?.toLowerCase() === 'system';

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      if (isSystemAdmin) {
        const r = await api.listOrganizations() as any;
        setOrgs(r.organizations || []);
      } else if (user?.organizationId) {
        const r = await api.getOrganization(user.organizationId) as any;
        setSelected(r.data);
      }
      setLoading(false);
    };
    load();
  }, [user, isSystemAdmin]);

  const selectOrg = async (org: any) => {
    if (selected?.id === org.id) { setSelected(null); return; }
    const q = await api.getOrganizationQuotas(org.id) as any;
    setSelected({ ...org, quotas: q.quotas || q });
    setEditing(false);
  };

  const saveOrg = async () => {
    await api.updateOrganization(selected.id, form);
    setSelected({ ...selected, ...form });
    setEditing(false);
    if (isSystemAdmin) {
      const r = await api.listOrganizations() as any;
      setOrgs(r.organizations || []);
    }
  };

  const filtered = orgs.filter(o => o.name.toLowerCase().includes(search.toLowerCase()));

  if (loading) return <DashboardLayout><Header title="Organizations" /><div className="p-6 text-center text-gray-500">Loading...</div></DashboardLayout>;

  // System Admin: list all orgs
  if (isSystemAdmin) {
    return (
      <DashboardLayout>
        <Header title="Organizations" description="Manage all organizations" />
        <div className="p-6">
          <div className="relative max-w-md mb-6">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-600" />
          </div>

          <div className="flex gap-6">
            <div className={selected ? 'flex-1' : 'w-full'}>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map(org => (
                  <Card key={org.id} className={`cursor-pointer hover:shadow-md ${selected?.id === org.id ? 'ring-2 ring-primary-500' : ''}`} onClick={() => selectOrg(org)}>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 bg-primary-100 dark:bg-primary-900 rounded-lg flex items-center justify-center">
                          <Building2 className="h-5 w-5 text-primary-600" />
                        </div>
                        <div>
                          <div className="font-semibold flex items-center gap-2">{org.name} {org.name.toLowerCase() === 'system' && <Badge variant="warning">System</Badge>}</div>
                          <div className="text-xs text-gray-500"><Users className="h-3 w-3 inline" /> {org.memberCount || 0}</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            {selected && (
              <Card className="w-80 shrink-0">
                <CardContent className="p-4 space-y-4">
                  <div className="flex justify-between">
                    <h3 className="font-semibold">Details</h3>
                    <div className="flex gap-1">
                      {!editing && <button onClick={() => { setForm({ name: selected.name, description: selected.description || '' }); setEditing(true); }}><Edit className="h-4 w-4" /></button>}
                      <button onClick={() => setSelected(null)}><X className="h-4 w-4" /></button>
                    </div>
                  </div>

                  {editing ? (
                    <div className="space-y-3">
                      <Input label="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                      <div><label className="block text-sm font-medium mb-1">Description</label>
                        <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600" />
                      </div>
                      <div className="flex gap-2"><Button size="sm" onClick={saveOrg}><Save className="h-3 w-3 mr-1" />Save</Button><Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button></div>
                    </div>
                  ) : (
                    <>
                      <div><div className="text-xs text-gray-500">Name</div><div>{selected.name}</div></div>
                      <div><div className="text-xs text-gray-500">Description</div><div>{selected.description || '-'}</div></div>
                      <div><div className="text-xs text-gray-500">Members</div><div>{selected.memberCount || 0}</div></div>
                      {selected.quotas && (
                        <div className="border-t pt-3 space-y-2">
                          <div className="text-xs font-medium flex items-center gap-1"><Gauge className="h-3 w-3" /> Quotas</div>
                          <QuotaBar label="Plugins" used={selected.quotas.plugins?.used || 0} limit={selected.quotas.plugins?.limit} resetAt={selected.quotas.plugins?.resetAt} />
                          <QuotaBar label="Pipelines" used={selected.quotas.pipelines?.used || 0} limit={selected.quotas.pipelines?.limit} resetAt={selected.quotas.pipelines?.resetAt} />
                          <QuotaBar label="API Calls" used={selected.quotas.apiCalls?.used || 0} limit={selected.quotas.apiCalls?.limit} resetAt={selected.quotas.apiCalls?.resetAt} />
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  // Regular user: own org only
  if (!selected) {
    return (
      <DashboardLayout>
        <Header title="Organization" />
        <div className="p-6"><Card><CardContent className="p-8 text-center text-gray-500"><Building2 className="h-12 w-12 mx-auto mb-2 opacity-50" />Not in an organization</CardContent></Card></div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <Header title="Organization" description="Your organization" />
      <div className="p-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 bg-primary-100 dark:bg-primary-900 rounded-xl flex items-center justify-center">
                <Building2 className="h-8 w-8 text-primary-600" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">{selected.name}</h2>
                <p className="text-gray-500">{selected.description || 'No description'}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
