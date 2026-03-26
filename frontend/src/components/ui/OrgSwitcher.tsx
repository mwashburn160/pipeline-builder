import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Building2, Check, Plus } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { isOrgAdmin, isSystemAdmin } from '@/types';
import api from '@/lib/api';

/**
 * Organization switcher dropdown.
 * Displays the active organization and allows switching between memberships.
 * Org admins and owners can create new organizations from this dropdown.
 */
export function OrgSwitcher() {
  const { user, organizations, switchOrganization, refreshUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTier, setNewOrgTier] = useState<'developer' | 'pro' | 'unlimited'>('developer');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCreate(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!user) return null;

  const canCreateOrg = isOrgAdmin(user) || isSystemAdmin(user);
  const activeOrg = organizations.find(o => o.id === user.organizationId);

  // Show switcher even with 1 org if user can create new ones
  if (organizations.length <= 1 && !canCreateOrg) return null;

  const handleSwitch = async (orgId: string) => {
    if (orgId === user.organizationId || switching) return;
    setSwitching(true);
    try {
      await switchOrganization(orgId);
      setOpen(false);
    } finally {
      setSwitching(false);
    }
  };

  const handleCreate = async () => {
    if (!newOrgName.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await api.createOrganization({ name: newOrgName.trim(), tier: newOrgTier });
      if (result.success) {
        setNewOrgName('');
        setNewOrgTier('developer');
        setShowCreate(false);
        setOpen(false);
        await refreshUser();
      } else {
        setCreateError(result.message || 'Failed to create organization');
      }
    } catch {
      setCreateError('Failed to create organization');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors w-full"
      >
        <Building2 className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <span className="truncate flex-1 text-left">{activeOrg?.name || user.organizationName || 'Select org'}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden">
          {/* Org list */}
          <div className="py-1 max-h-48 overflow-y-auto">
            {organizations.map((org) => {
              const isActive = org.id === user.organizationId;
              return (
                <button
                  key={org.id}
                  type="button"
                  onClick={() => handleSwitch(org.id)}
                  disabled={switching}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <span className="truncate flex-1 text-left">{org.name}</span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{org.role}</span>
                  {isActive && <Check className="w-3.5 h-3.5 text-blue-500 shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Create org section — admin/owner only */}
          {canCreateOrg && (
            <div className="border-t border-gray-200 dark:border-gray-700">
              {showCreate ? (
                <div className="p-3 space-y-2">
                  <input
                    type="text"
                    value={newOrgName}
                    onChange={(e) => { setNewOrgName(e.target.value); setCreateError(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                    placeholder="Organization name"
                    className="input !py-1.5 text-sm w-full"
                    autoFocus
                    disabled={creating}
                  />
                  <select
                    value={newOrgTier}
                    onChange={(e) => setNewOrgTier(e.target.value as 'developer' | 'pro' | 'unlimited')}
                    className="input !py-1.5 text-sm w-full"
                    disabled={creating}
                  >
                    <option value="developer">Developer</option>
                    <option value="pro">Pro</option>
                    <option value="unlimited">Unlimited</option>
                  </select>
                  {createError && (
                    <p className="text-xs text-red-600 dark:text-red-400">{createError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreate}
                      disabled={!newOrgName.trim() || creating}
                      className="btn btn-primary text-xs px-3 py-1 flex-1"
                    >
                      {creating ? 'Creating...' : 'Create'}
                    </button>
                    <button
                      onClick={() => { setShowCreate(false); setNewOrgName(''); setNewOrgTier('developer'); setCreateError(null); }}
                      className="btn btn-secondary text-xs px-3 py-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Create Organization
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
