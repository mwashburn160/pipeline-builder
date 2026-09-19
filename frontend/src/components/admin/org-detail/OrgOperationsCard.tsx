// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { useRouter } from 'next/router';
import { Download, FileDown, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/csv-export';
import type { OrganizationDetail } from '@/lib/api/domains/organizations';

/**
 * Scaffolding + destructive operations for one org: the k8s namespace manifest
 * (step-up — it pins service-account tokens and namespace labels), the GDPR
 * export, the org's audit trail, and the soft delete (typed confirmation, then
 * step-up).
 */
export function OrgOperationsCard({ org }: { org: OrganizationDetail }) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingOp, setPendingOp] = useState<'delete' | 'yaml' | null>(null);

  // GDPR portability dump. The endpoint streams raw JSON (not an ApiResponse
  // envelope); the client method returns the body text, saved here as a file.
  const exportData = async () => {
    setExporting(true);
    try {
      const json = await api.exportOrganization(org.id);
      triggerBlobDownload(new Blob([json], { type: 'application/json' }), `org-${org.slug ?? org.id}-export.json`);
      toast.success('Organization data exported');
    } catch (e) {
      setError(formatError(e, 'Failed to export organization data'));
    } finally {
      setExporting(false);
    }
  };

  const onStepUpConfirmed = async (stepUpToken: string) => {
    const op = pendingOp;
    setPendingOp(null);
    try {
      if (op === 'yaml') {
        const yaml = await api.getOrgNamespaceYaml(org.id, stepUpToken);
        triggerBlobDownload(new Blob([yaml], { type: 'application/yaml' }), `pb-org-${org.slug ?? org.id}.yaml`);
        toast.success('Namespace YAML downloaded');
      } else if (op === 'delete') {
        await api.deleteOrganization(org.id, stepUpToken);
        void router.push('/dashboard/organizations');
      }
    } catch (e) {
      setError(formatError(e, op === 'delete' ? 'Failed to delete organization' : 'Failed to download namespace YAML'));
    }
  };

  return (
    <Card>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Operations</h3>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setPendingOp('yaml')} className="inline-flex items-center gap-2 text-sm">
          <FileDown className="w-4 h-4" /> Download k8s namespace YAML
        </Button>
        <Button variant="secondary" onClick={() => void exportData()} disabled={exporting} className="inline-flex items-center gap-2 text-sm disabled:opacity-60">
          <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export data'}
        </Button>
        <LinkButton href={`/dashboard/audit?affectedOrgId=${org.id}`} variant="secondary" className="text-sm">
          View audit log
        </LinkButton>
        <div className="flex-1" />
        <Button variant="danger" onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-2 text-sm">
          <Trash2 className="w-4 h-4" /> Delete organization
        </Button>
      </div>

      {/* The typed-name confirmation clears first; the step-up then runs the delete. */}
      {confirmDelete && (
        <DeleteConfirmModal
          title="Delete Organization"
          itemName={org.name}
          loading={false}
          onConfirm={() => { setConfirmDelete(false); setPendingOp('delete'); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {pendingOp && (
        <StepUpModal
          action={pendingOp === 'delete' ? `Delete organization ${org.name}` : `Download k8s namespace YAML for ${org.name}`}
          onConfirmed={onStepUpConfirmed}
          onClose={() => setPendingOp(null)}
        />
      )}
    </Card>
  );
}
