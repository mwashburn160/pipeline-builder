// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { api, getErrorMessage } from '@/lib/api';

/**
 * Create-dashboard page. Captures the metadata (name / description /
 * visibility) and posts an empty dashboard; the editor handles panel-add
 * afterwards. Two-step rather than one because the editor needs a known
 * dashboard id to PUT against, and bundling create+save would require an
 * "empty dashboard with no panels" intermediate state in the API.
 */
export default function NewDashboardPage() {
  // View on `dashboards:read`; the actual create action is a `dashboards:write`
  // capability gated via `can()`, which reports false under read-only
  // impersonation so the Create button disables (superadmins bypass).
  const { isReady, isAuthenticated, can } = useAuthGuard({ requirePermission: 'dashboards:read' });
  const canWrite = can('dashboards:write');
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'org' | 'public'>('private');
  const [submitting, setSubmitting] = useState(false);

  const onCreate = async () => {
    if (!name.trim() || !canWrite) return;
    setSubmitting(true);
    try {
      const res = await api.createDashboard({
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        visibility,
        panels: [],
      });
      const id = res.data?.dashboard.id;
      if (!id) throw new Error('Server returned no dashboard id');
      toast.success('Dashboard created');
      void router.push(`/dashboard/observability/${id}/edit`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout title="New dashboard" subtitle="Create an empty dashboard, then add panels in the editor.">
      <div className="max-w-xl rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name <span className="text-red-500">*</span></label>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My team's plugin uptake"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="One sentence about what this dashboard surfaces."
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Visibility</label>
          <Select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
          >
            <option value="private">Private (only me)</option>
            <option value="org">Org (anyone in my organization)</option>
            <option value="public">Public — sysadmin only</option>
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <LinkButton
            href="/dashboard/observability"
            variant="secondary"
            size="sm"
          >
            Cancel
          </LinkButton>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onCreate()}
            disabled={submitting || !name.trim() || !canWrite}
            title={canWrite ? undefined : 'Read-only — requires dashboards:write'}
          >
            {submitting ? 'Creating…' : 'Create & add panels'}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}
