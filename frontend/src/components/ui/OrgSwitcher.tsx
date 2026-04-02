import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import { ChevronDown, Building2, Check } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { clearPluginCache } from '@/hooks/usePlugins';

/**
 * Organization switcher dropdown.
 * Displays the active organization and allows switching between memberships.
 * Only renders when the user belongs to multiple organizations.
 */
export function OrgSwitcher() {
  const { user, organizations, switchOrganization } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!user) return null;

  const activeOrg = organizations.find(o => o.id === user.organizationId);

  // Only show switcher when user has multiple orgs
  if (organizations.length <= 1) return null;

  const handleSwitch = async (orgId: string) => {
    if (orgId === user.organizationId || switching) return;
    setSwitching(true);
    try {
      await switchOrganization(orgId);
      clearPluginCache();
      setOpen(false);
      const orgName = organizations.find(o => o.id === orgId)?.name || orgId;
      toast.success(`Switched to ${orgName}`);
      router.replace(router.asPath);
    } finally {
      setSwitching(false);
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
        <div className="absolute left-0 right-0 bottom-full mb-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden">
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
        </div>
      )}
    </div>
  );
}
