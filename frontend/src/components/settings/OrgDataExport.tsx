// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Download, PackageOpen } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SectionCard } from '@/components/ui/SectionCard';
import api from '@/lib/api';
import { useMutation } from '@/hooks/useMutation';
import { triggerBlobDownload } from '@/lib/download';

/**
 * The organization's own data export (`GET /organization/:id/export`, the
 * GDPR-portability dump). The endpoint was reachable only from the sysadmin's
 * org detail page and a team's card — an org's own admin had no way to take
 * their data with them. It is a read, so it works during a read-only session.
 */
export function OrgDataExport({ orgId, orgName }: { orgId: string; orgName?: string }) {
  const [done, setDone] = useState(false);

  const exportData = useMutation({
    fn: async () => {
      setDone(false);
      return api.exportOrganization(orgId);
    },
    scopeKey: orgId,
    errorFallback: 'Could not export the organization\'s data',
    onSuccess: (json) => {
      const slug = (orgName ?? orgId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || orgId;
      triggerBlobDownload(new Blob([json], { type: 'application/json' }), `org-${slug}-export.json`);
      setDone(true);
    },
  });

  return (
    <SectionCard
      icon={PackageOpen}
      title="Export organization data"
      description="Download what the platform holds for this organization — its profile, members, roles, pipelines, plugins, settings and recent audit events — as one JSON file, for your records or to move elsewhere."
    >
      <div className="space-y-3">
        <ErrorAlert message={exportData.error} onDismiss={exportData.reset} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => void exportData.run()} loading={exportData.pending} className="gap-1">
            <Download className="h-4 w-4" aria-hidden /> Download export
          </Button>
          {done && <span className="text-xs text-fg-muted" role="status">Export downloaded.</span>}
        </div>
      </div>
    </SectionCard>
  );
}
