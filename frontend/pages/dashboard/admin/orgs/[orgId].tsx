// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin org-detail page.
 *
 * Consolidates everything a sysadmin needs about a single org onto one
 * surface: identity, tier + quotas, KMS binding, IdP / SSO config, member
 * count, and quick-actions for namespace YAML + delete. Previously each
 * piece required a separate trip through the orgs list + a modal, or a
 * shell + curl for surfaces with no UI at all.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ArrowLeft, Building2, KeyRound, ShieldCheck, FileDown, Users, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { OrgKmsConfigModal } from '@/components/admin/OrgKmsConfigModal';
import { OrgIdpConfigModal } from '@/components/admin/OrgIdpConfigModal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { formatError } from '@/lib/constants';
import { TIER_KEYS, getTierMeta } from '@/lib/tiers';
import api from '@/lib/api';
import type { Organization, OrgIdpConfigDto } from '@/types';

interface KmsStatus { configured: boolean; keyId?: string }

export default function OrgDetailPage() {
  const router = useRouter();
  const orgId = String(router.query.orgId || '');
  const { isReady, user } = useAuthGuard({ requireSystemAdmin: true });

  const [org, setOrg] = useState<Organization | null>(null);
  const [kms, setKms] = useState<KmsStatus | null>(null);
  const [idp, setIdp] = useState<OrgIdpConfigDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showKms, setShowKms] = useState(false);
  const [showIdp, setShowIdp] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Step-up gates the destructive ops (delete + namespace YAML download
  // + tier change). KMS save/clear gate themselves inside OrgKmsConfigModal.
  const [pendingOp, setPendingOp] = useState<'delete' | 'yaml' | 'tier' | null>(null);
  // Tier the operator selected in the dropdown; only applied after step-up.
  const [pendingTier, setPendingTier] = useState<'developer' | 'pro' | 'team' | 'enterprise' | null>(null);

  const reload = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      // Parallel fetch — the three calls are independent, and the page
      // renders fully only after all three land.
      const [orgRes, kmsRes, idpRes] = await Promise.all([
        api.getOrganization(orgId),
        api.getOrgKmsConfig(orgId),
        api.getOrgIdpConfig(orgId).catch(() => null),
      ]);
      if (orgRes.success && orgRes.data?.organization) setOrg(orgRes.data.organization);
      else throw new Error(orgRes.message || 'Failed to load organization');
      if (kmsRes.success && kmsRes.data) setKms(kmsRes.data);
      if (idpRes?.success && idpRes.data?.config) setIdp(idpRes.data.config);
      else setIdp(null);
    } catch (e) {
      setError(formatError(e, 'Failed to load org details'));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void reload(); }, [reload]);

  const executeDownloadNamespaceYaml = useCallback(async (stepUpToken: string) => {
    if (!org) return;
    try {
      const yaml = await api.getOrgNamespaceYaml(org.id, stepUpToken);
      const blob = new Blob([yaml], { type: 'application/yaml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pb-org-${org.slug ?? org.id}.yaml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(formatError(e, 'Failed to download namespace YAML'));
    }
  }, [org]);

  const executeDelete = useCallback(async (stepUpToken: string) => {
    if (!org) return;
    setDeleting(true);
    try {
      const res = await api.deleteOrganization(org.id, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Delete failed');
      router.push('/dashboard/organizations');
    } catch (e) {
      setError(formatError(e, 'Failed to delete organization'));
    } finally {
      setDeleting(false);
    }
  }, [org, router]);

  // confirmDelete is now invoked after the user clears the
  // DeleteConfirmModal — it opens the step-up modal instead of running
  // the delete directly. executeDelete fires once step-up succeeds.
  const confirmDelete = useCallback(() => {
    setShowDelete(false);
    setPendingOp('delete');
  }, []);

  // Same pattern for namespace YAML — sensitive because the YAML pins
  // service-account tokens / namespace labels operators care about.
  const downloadNamespaceYaml = useCallback(() => {
    setPendingOp('yaml');
  }, []);

  const executeTierChange = useCallback(async (stepUpToken: string) => {
    if (!org || !pendingTier) return;
    try {
      const res = await api.updateOrganizationTier(org.id, pendingTier, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Tier update failed');
      await reload();
    } catch (e) {
      setError(formatError(e, 'Failed to update tier'));
    } finally {
      setPendingTier(null);
    }
  }, [org, pendingTier, reload]);

  const onStepUpConfirmed = useCallback(async (stepUpToken: string) => {
    const op = pendingOp;
    setPendingOp(null);
    if (op === 'delete') await executeDelete(stepUpToken);
    if (op === 'yaml') await executeDownloadNamespaceYaml(stepUpToken);
    if (op === 'tier') await executeTierChange(stepUpToken);
  }, [pendingOp, executeDelete, executeDownloadNamespaceYaml, executeTierChange]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title={org ? org.name : 'Organization'}
      subtitle="System-admin org detail"
      breadcrumbs={[
        { label: 'All Organizations', href: '/dashboard/organizations' },
        { label: org ? org.name : 'Organization' },
      ]}
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      <div className="mb-4">
        <Link href="/dashboard/organizations" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to organizations
        </Link>
      </div>

      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      {loading && !org && <LoadingSpinner />}

      {org && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Identity card */}
          <div className="card">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Identity</h3>
              </div>
              {/* Sysadmin tier change. The select fires the step-up flow, then
                  the actual PATCH runs via executeTierChange. Disabled on the
                  current tier (no-op) so accidental clicks don't trigger a
                  step-up prompt. */}
              <select
                value={org.tier ?? 'developer'}
                onChange={(e) => {
                  const newTier = e.target.value as 'developer' | 'pro' | 'team' | 'enterprise';
                  if (newTier === (org.tier ?? 'developer')) return;
                  setPendingTier(newTier);
                  setPendingOp('tier');
                }}
                className="filter-select text-xs"
                aria-label="Change pricing tier"
              >
                {TIER_KEYS.map((tier) => (
                  <option key={tier} value={tier}>{getTierMeta(tier).label}</option>
                ))}
              </select>
            </div>
            <dl className="text-sm space-y-2">
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Org id</dt>
                <dd><CopyableId value={org.id} size="sm" /></dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Slug</dt>
                <dd>{org.slug ? <CopyableId value={org.slug} size="sm" /> : <code className="text-xs">—</code>}</dd>
              </div>
              {org.description && (
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">Description</dt>
                  <dd>{org.description}</dd>
                </div>
              )}
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Created</dt>
                <dd><RelativeTime value={org.createdAt} /></dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Members</dt>
                <dd className="inline-flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-gray-400" /> {org.memberCount}
                </dd>
              </div>
            </dl>
          </div>

          {/* KMS card */}
          <div className="card">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Per-org KMS</h3>
              </div>
              <button onClick={() => setShowKms(true)} className="action-link text-sm">
                {kms?.configured ? 'Rotate / clear' : 'Configure'}
              </button>
            </div>
            {kms?.configured ? (
              <div className="text-sm">
                <div className="text-gray-500 dark:text-gray-400 mb-1">Wrapping under operator CMK:</div>
                <CopyableId value={kms.keyId ?? ''} size="sm" />
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Falling back to the shared SECRET_ENCRYPTION_KEY master.
                Configure to wrap this org&apos;s secrets under its own CMK.
              </p>
            )}
          </div>

          {/* IdP card */}
          <div className="card">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">SSO / IdP</h3>
              </div>
              <button onClick={() => setShowIdp(true)} className="action-link text-sm">
                {idp ? 'Edit / remove' : 'Configure'}
              </button>
            </div>
            {idp ? (
              <dl className="text-sm space-y-1.5">
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">Provider</dt>
                  <dd><code className="text-xs">{idp.provider}</code> {idp.enabled ? <Badge color="green">enabled</Badge> : <Badge color="yellow">disabled</Badge>}</dd>
                </div>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">Client ID</dt>
                  <dd><CopyableId value={idp.clientId} size="sm" /></dd>
                </div>
                {idp.discoveryUrl && (
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">Discovery URL</dt>
                    <dd className="break-all"><CopyableId value={idp.discoveryUrl} size="sm" /></dd>
                  </div>
                )}
                {idp.allowedEmailDomains.length > 0 && (
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">Allowed domains</dt>
                    <dd>{idp.allowedEmailDomains.join(', ')}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No SSO configured. Members sign in via password / OAuth defaults.
              </p>
            )}
          </div>

          {/* Quotas card */}
          {org.quotas && (
            <div className="card">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Quotas</h3>
              <dl className="text-sm space-y-1.5">
                {Object.entries(org.quotas).map(([type, summary]) => (
                  <div key={type} className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">{type}</dt>
                    <dd className="font-mono text-xs">
                      {summary.used} / {summary.limit === -1 ? '∞' : summary.limit}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Operations card — destructive + scaffolding actions */}
          <div className="card lg:col-span-2">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Operations</h3>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={downloadNamespaceYaml} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
                <FileDown className="w-4 h-4" /> Download k8s namespace YAML
              </button>
              <Link href={`/dashboard/audit?affectedOrgId=${org.id}`} className="btn btn-secondary text-sm">
                View audit log
              </Link>
              <div className="flex-1" />
              <button onClick={() => setShowDelete(true)} className="btn btn-danger inline-flex items-center gap-2 text-sm">
                <Trash2 className="w-4 h-4" /> Delete organization
              </button>
            </div>
          </div>
        </div>
      )}

      {showKms && org && (
        <OrgKmsConfigModal org={org} onClose={() => { setShowKms(false); void reload(); }} onSaved={reload} />
      )}

      {showIdp && org && (
        <OrgIdpConfigModal org={org} onClose={() => { setShowIdp(false); void reload(); }} onSaved={reload} />
      )}

      {showDelete && org && (
        <DeleteConfirmModal
          title="Delete Organization"
          itemName={org.name}
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setShowDelete(false)}
        />
      )}

      {pendingOp && org && (
        <StepUpModal
          action={pendingOp === 'delete'
            ? `Delete organization ${org.name}`
            : pendingOp === 'yaml'
              ? `Download k8s namespace YAML for ${org.name}`
              : `Change ${org.name} tier to ${pendingTier} (reseeds quota limits)`}
          onConfirmed={onStepUpConfirmed}
          onClose={() => { setPendingOp(null); setPendingTier(null); }}
        />
      )}
    </DashboardLayout>
  );
}
