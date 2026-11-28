// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { useRouter } from 'next/router';
import { Download, FileDown, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { continueAfterStepUp } from '@/lib/api/errors';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useMutation } from '@/hooks/useMutation';
import { LinkButton } from '@/components/ui/LinkButton';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import type { OrganizationDetail } from '@/lib/api/domains/organizations-lifecycle';

/**
 * Scaffolding + destructive operations for one org: the k8s namespace manifest
 * (step-up — it pins service-account tokens and namespace labels), the GDPR
 * export (step-up — a bulk read of everything the org owns), the org's audit
 * trail, and the soft delete. Every step-up-gated operation states what it
 * costs inside the step-up dialog itself.
 */
export function OrgOperationsCard({ org }: { org: OrganizationDetail }) {
  // `orgs:manage`, which is NOT what gets you this page — that is `orgs:read`,
  // split out of `platform:read` so the read-only job Roles could find an org by
  // name. Four of the five (Platform Observer, Console Administrator, Support
  // Agent, Platform Operator) hold the read and not the manage, and this card
  // offered every one of them a Delete that answered 403. `can` rather than
  // `hasPermission` so a read-only impersonation is refused too.
  const { can } = useAuthGuard();
  const mayManage = can('orgs:manage');
  // A root with live teams cannot be deleted — the backend refuses (400) so the
  // teams aren't orphaned. Refusing here, BEFORE the step-up re-auth, turns a
  // dead end into an answer with the way out in it. Read off the org on screen
  // (sysadmin `teams`), not the viewer's.
  const liveTeams = org.teams ?? [];
  const blockedByTeams = liveTeams.length > 0;
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  // All three operations are step-up gated, so each is ONE dialog that states
  // what it costs and takes the factor — no confirm modal in front of it.
  const [pendingOp, setPendingOp] = useState<'delete' | 'yaml' | 'export' | null>(null);

  // GDPR portability dump. The endpoint streams raw JSON (not an ApiResponse
  // envelope); the client method returns the body text, saved here as a file.
  // Step-up gated server-side (a bulk read of every row the org owns).
  const saveExport = (json: string) => {
    triggerBlobDownload(new Blob([json], { type: 'application/json' }), `org-${org.slug ?? org.id}-export.json`);
  };
  const exportM = useMutation({
    fn: (stepUpToken: string) => api.exportOrganization(org.id, stepUpToken),
    scopeKey: org.id,
    errorFallback: 'Failed to export organization data',
    toast: { success: 'Organization data exported' },
    onSuccess: saveExport,
    // A refused token (expired, already spent) is handed to the global step-up
    // dialog; its replay carries the export body, which is the file to save.
    onStepUpResumed: (json) => {
      saveExport(json as string);
      toast.success('Organization data exported');
    },
    onError: (_e, message) => setError(message),
  });
  const exporting = exportM.pending;

  const onStepUpConfirmed = async (stepUpToken: string) => {
    const op = pendingOp;
    setPendingOp(null);
    if (op === 'export') {
      // useMutation owns the export's error, toast and step-up replay.
      void exportM.run(stepUpToken);
      return;
    }
    const saveYaml = (yaml: string) => {
      triggerBlobDownload(new Blob([yaml], { type: 'application/yaml' }), `pb-org-${org.slug ?? org.id}.yaml`);
      toast.success('Namespace YAML downloaded');
    };
    const afterDelete = () => {
      // The list this navigates to reads through the shared cache.
      invalidate.organizations();
      void router.push('/dashboard/organizations');
    };
    try {
      if (op === 'yaml') {
        saveYaml(await api.getOrgNamespaceYaml(org.id, stepUpToken));
      } else if (op === 'delete') {
        await api.deleteOrganization(org.id, stepUpToken);
        afterDelete();
      }
    } catch (e) {
      // A refused token is handed to the global step-up dialog, which replays
      // the request: finish with the replay's answer instead of showing an error.
      if (op === 'yaml' && continueAfterStepUp<string>(e, saveYaml)) return;
      if (op === 'delete' && continueAfterStepUp(e, afterDelete)) return;
      setError(formatError(e, op === 'delete' ? 'Failed to delete organization' : 'Failed to download namespace YAML'));
    }
  };

  return (
    <Card>
      <h3 className="text-base font-semibold text-fg mb-3">Operations</h3>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setPendingOp('yaml')} className="inline-flex items-center gap-2 text-sm">
          <FileDown className="w-4 h-4" /> Download k8s namespace YAML
        </Button>
        <Button variant="secondary" onClick={() => setPendingOp('export')} disabled={exporting} className="inline-flex items-center gap-2 text-sm disabled:opacity-60">
          <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export data'}
        </Button>
        <LinkButton href={`/dashboard/audit?affectedOrgId=${org.id}`} variant="secondary" className="text-sm">
          View audit log
        </LinkButton>
        <div className="flex-1" />
        <Button
          variant="danger"
          onClick={() => setPendingOp('delete')}
          disabled={blockedByTeams || !mayManage}
          title={!mayManage
            ? 'Requires the orgs:manage permission'
            : blockedByTeams ? 'This organization has teams — move or delete them first' : undefined}
          className="inline-flex items-center gap-2 text-sm disabled:opacity-60"
        >
          <Trash2 className="w-4 h-4" /> Delete organization
        </Button>
      </div>
      {blockedByTeams && (
        <p className="mt-2 text-xs text-fg-muted">
          {org.name} has {liveTeams.length} team{liveTeams.length === 1 ? '' : 's'} and can&apos;t be deleted while
          they exist. Delete each team, or move it under another organization or out as a standalone one (Configuration →
          Hierarchy), then come back.
        </p>
      )}

      {/* ONE dialog: what is lost, and the factor — never a confirm followed by
          a second modal for the same click. */}
      {pendingOp && (
        <StepUpModal
          title={pendingOp === 'delete' ? `Delete ${org.name}?`
            : pendingOp === 'export' ? `Export ${org.name}'s data?` : `Download ${org.name}'s namespace YAML?`}
          action={pendingOp === 'delete' ? `Delete organization ${org.name}`
            : pendingOp === 'export' ? `Export all data for ${org.name}` : `Download k8s namespace YAML for ${org.name}`}
          details={pendingOp === 'delete' ? (
            <p>
              <strong className="text-fg">{org.name}</strong> and its members, pipelines, plugins and settings stop being
              reachable. It is soft-deleted and restorable from the organizations list until its retention window ends,
              then purged permanently. Export its data first if you need a copy.
            </p>
          ) : pendingOp === 'export' ? (
            <p>
              The file holds every row the platform keeps for <strong className="text-fg">{org.name}</strong> — members,
              settings, pipelines and audit events. Store it somewhere safe.
            </p>
          ) : (
            <p>
              The manifest pins <strong className="text-fg">{org.name}</strong>&apos;s namespace labels and
              service-account tokens — treat the file as a credential.
            </p>
          )}
          onConfirmed={onStepUpConfirmed}
          onClose={() => setPendingOp(null)}
        />
      )}
    </Card>
  );
}
