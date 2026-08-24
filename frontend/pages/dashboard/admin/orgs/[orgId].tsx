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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ArrowLeft, Building2, KeyRound, ShieldCheck, FileDown, Users, Trash2, Armchair, Sparkles, Download } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TabBar } from '@/components/ui/TabBar';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { OrgKmsConfigModal } from '@/components/admin/OrgKmsConfigModal';
import { OrgIdpConfigModal } from '@/components/admin/OrgIdpConfigModal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import { useFormState } from '@/hooks/useFormState';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { formatError } from '@/lib/constants';
import { redactString } from '@/lib/redact';
import { triggerBlobDownload } from '@/lib/csv-export';
import { TIER_KEYS, getTierMeta } from '@/lib/tiers';
import api from '@/lib/api';
import type { Organization, OrgIdpConfigDto } from '@/types';

interface KmsStatus { configured: boolean; keyId?: string }

const ORG_TABS = [
  { id: 'configuration', label: 'Configuration' },
  { id: 'entitlements', label: 'Entitlements' },
  { id: 'operations', label: 'Operations' },
] as const;
type OrgTab = (typeof ORG_TABS)[number]['id'];
const ORG_TAB_IDS = ORG_TABS.map((t) => t.id) as readonly string[];

export default function OrgDetailPage() {
  const router = useRouter();
  const orgId = String(router.query.orgId || '');
  const { isReady, user, can } = useAuthGuard({ requireSystemAdmin: true });
  const toast = useToast();

  // The 7 cards are grouped into tabs (Configuration / Entitlements / Operations)
  // so the page isn't one long scroll. Deep-linkable via `?tab=` (separate from
  // the `?orgId` route param).
  const [activeTab, setActiveTab] = useState<OrgTab>('configuration');
  useEffect(() => {
    const raw = Array.isArray(router.query.tab) ? router.query.tab[0] : router.query.tab;
    if (raw && ORG_TAB_IDS.includes(raw) && raw !== activeTab) setActiveTab(raw as OrgTab);
  }, [router.query.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeTab = (tabId: string) => {
    setActiveTab(tabId as OrgTab);
    void router.replace({ query: { ...router.query, tab: tabId } }, undefined, { shallow: true });
  };

  const [org, setOrg] = useState<Organization | null>(null);
  const [kms, setKms] = useState<KmsStatus | null>(null);
  const [idp, setIdp] = useState<OrgIdpConfigDto | null>(null);
  // Pooled seat usage + account feature entitlements. Both fail-soft: a 403
  // (non-account org) or an empty account just renders an empty/muted state.
  const [seatUsage, setSeatUsage] = useState<{ limit: number; used: number } | null>(null);
  const [features, setFeatures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showKms, setShowKms] = useState(false);
  const [showIdp, setShowIdp] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Step-up gates the destructive ops (delete + namespace YAML download
  // + tier change). KMS save/clear gate themselves inside OrgKmsConfigModal.
  const [pendingOp, setPendingOp] = useState<'delete' | 'yaml' | 'tier' | null>(null);
  // Tier the operator selected in the dropdown; only applied after step-up.
  const [pendingTier, setPendingTier] = useState<'developer' | 'pro' | 'team' | 'enterprise' | null>(null);

  // Identity edit (name + slug). Backed by the quota service's PUT which accepts
  // name/slug/tier/quotas — NOT description, so description stays read-only here.
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const editForm = useFormState();

  // Seat-limit editor. `seats` is platform-owned (not a quota type); -1 = unlimited.
  // The PUT is sysadmin/service only + no step-up, so no StepUpModal here.
  const [showSeatLimit, setShowSeatLimit] = useState(false);
  const [seatLimitInput, setSeatLimitInput] = useState('');
  const [seatUnlimited, setSeatUnlimited] = useState(false);
  const seatForm = useFormState();

  const reload = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      // Parallel fetch — the calls are independent, and the page renders fully
      // only after they land. Seat usage + feature entitlements are fail-soft
      // (`.catch`) so a 403/404 on either never blocks the core org detail.
      const [orgRes, kmsRes, idpRes, seatRes, featRes] = await Promise.all([
        api.getOrganization(orgId),
        api.getOrgKmsConfig(orgId),
        api.getOrgIdpConfig(orgId).catch(() => null),
        api.getOrganizationSeatUsage(orgId).catch(() => null),
        api.getOrganizationFeatureEntitlements(orgId).catch(() => null),
      ]);
      if (orgRes.success && orgRes.data) setOrg(orgRes.data);
      else throw new Error(orgRes.message || 'Failed to load organization');
      if (kmsRes.success && kmsRes.data) setKms(kmsRes.data);
      if (idpRes?.success && idpRes.data?.config) setIdp(idpRes.data.config);
      else setIdp(null);
      if (seatRes?.success && seatRes.data) setSeatUsage(seatRes.data);
      else setSeatUsage(null);
      if (featRes?.success && featRes.data) setFeatures(featRes.data.featureEntitlements ?? []);
      else setFeatures([]);
    } catch (e) {
      setError(formatError(e, 'Failed to load org details'));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void reload(); }, [reload]);

  // Deep-link from the IdP roster ("Edit" → `?edit=idp`) opens the IdP editor
  // directly instead of just landing on this detail page. Handled once (ref
  // guard) so closing the modal doesn't immediately re-open it.
  const idpDeepLinkHandled = useRef(false);
  useEffect(() => {
    if (org && router.query.edit === 'idp' && !idpDeepLinkHandled.current) {
      idpDeepLinkHandled.current = true;
      setShowIdp(true);
    }
  }, [org, router.query.edit]);

  const openEdit = useCallback(() => {
    if (!org) return;
    setEditName(org.name ?? '');
    setEditSlug(org.slug ?? '');
    editForm.reset();
    setShowEdit(true);
  }, [org, editForm]);

  const handleSaveIdentity = useCallback(async () => {
    if (!org) return;
    const changes: { name?: string; slug?: string } = {};
    const name = editName.trim();
    const slug = editSlug.trim();
    if (name && name !== org.name) changes.name = name;
    if (slug && slug !== (org.slug ?? '')) changes.slug = slug;
    if (Object.keys(changes).length === 0) {
      editForm.setError('No changes to save');
      return;
    }
    const result = await editForm.run(() => api.updateOrgQuotas(org.id, changes));
    if (result !== null && result.success) {
      setShowEdit(false);
      await reload();
    } else if (result !== null) {
      editForm.setError(result.message || 'Failed to update organization');
    }
  }, [org, editName, editSlug, editForm, reload]);

  const openSeatLimit = useCallback(() => {
    const current = seatUsage?.limit ?? 0;
    if (current === -1) {
      setSeatUnlimited(true);
      setSeatLimitInput('');
    } else {
      setSeatUnlimited(false);
      setSeatLimitInput(String(current));
    }
    seatForm.reset();
    setShowSeatLimit(true);
  }, [seatUsage, seatForm]);

  const handleSaveSeatLimit = useCallback(async () => {
    if (!org) return;
    let seats: number;
    if (seatUnlimited) {
      seats = -1;
    } else {
      const n = Number(seatLimitInput);
      if (!Number.isInteger(n) || n < 0) {
        seatForm.setError('Enter a whole number of seats (0 or more), or check Unlimited.');
        return;
      }
      seats = n;
    }
    const result = await seatForm.run(() => api.setOrganizationSeatLimit(org.id, seats));
    if (result !== null && result.success) {
      setShowSeatLimit(false);
      await reload();
    } else if (result !== null) {
      seatForm.setError(result.message || 'Failed to set seat limit');
    }
  }, [org, seatUnlimited, seatLimitInput, seatForm, reload]);

  // GDPR portability dump. The endpoint streams raw JSON (not an ApiResponse
  // envelope); the client method returns the body text, saved here as a file.
  const handleExport = useCallback(async () => {
    if (!org) return;
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
  }, [org, toast]);

  const executeDownloadNamespaceYaml = useCallback(async (stepUpToken: string) => {
    if (!org) return;
    try {
      const yaml = await api.getOrgNamespaceYaml(org.id, stepUpToken);
      triggerBlobDownload(new Blob([yaml], { type: 'application/yaml' }), `pb-org-${org.slug ?? org.id}.yaml`);
      toast.success('Namespace YAML downloaded');
    } catch (e) {
      setError(formatError(e, 'Failed to download namespace YAML'));
    }
  }, [org, toast]);

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

      {/* When the org is already loaded, `error` is a transient action failure
          (export / tier / delete) → dismissable banner. When the initial load
          itself failed (no org rendered), show a distinct retryable error instead
          of a bare dismiss with nothing behind it. */}
      {org && <ErrorAlert message={error} onDismiss={() => setError(null)} />}

      {loading && !org && <LoadingSpinner />}

      {!loading && !org && error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void reload()} className="underline hover:no-underline">Retry</button>
        </div>
      )}

      {org && (
        <>
        <TabBar items={[...ORG_TABS]} activeId={activeTab} onSelect={changeTab} className="mb-4" />

        {activeTab === 'configuration' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Identity card */}
          <Card>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Identity</h3>
              </div>
              <div className="flex items-center gap-3">
              <button onClick={openEdit} className="action-link text-sm">Edit</button>
              {/* Sysadmin tier change. The select fires the step-up flow, then
                  the actual PATCH runs via executeTierChange. Disabled on the
                  current tier (no-op) so accidental clicks don't trigger a
                  step-up prompt. */}
              <FilterSelect
                value={org.tier ?? 'developer'}
                onChange={(e) => {
                  const newTier = e.target.value as 'developer' | 'pro' | 'team' | 'enterprise';
                  if (newTier === (org.tier ?? 'developer')) return;
                  setPendingTier(newTier);
                  setPendingOp('tier');
                }}
                className="text-xs"
                aria-label="Change pricing tier"
              >
                {TIER_KEYS.map((tier) => (
                  <option key={tier} value={tier}>{getTierMeta(tier).label}</option>
                ))}
              </FilterSelect>
              </div>
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
          </Card>

          {/* KMS card */}
          <Card>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Per-org KMS</h3>
              </div>
              {can('org:kms') && (
                <button onClick={() => setShowKms(true)} className="action-link text-sm">
                  {kms?.configured ? 'Rotate / clear' : 'Configure'}
                </button>
              )}
            </div>
            {kms?.configured ? (
              <div className="text-sm">
                <div className="text-gray-500 dark:text-gray-400 mb-1">Wrapping under operator CMK:</div>
                {/* A KMS key ARN embeds the AWS account id; redact it before it
                    reaches the DOM or the clipboard (CopyableId copies `value`). */}
                <CopyableId value={redactString(kms.keyId ?? '')} size="sm" />
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Falling back to the shared SECRET_ENCRYPTION_KEY master.
                Configure to wrap this org&apos;s secrets under its own CMK.
              </p>
            )}
          </Card>

          {/* IdP card */}
          <Card>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">SSO / IdP</h3>
              </div>
              {can('org:idp') && (
                <button onClick={() => setShowIdp(true)} className="action-link text-sm">
                  {idp ? 'Edit / remove' : 'Configure'}
                </button>
              )}
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
          </Card>
        </div>
        )}

        {activeTab === 'entitlements' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Seats card — pooled account seat usage + a sysadmin control to set
              the seat limit. Usage is account-scoped (resolves to the root). */}
          <Card>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <Armchair className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Seats</h3>
              </div>
              <button onClick={openSeatLimit} className="action-link text-sm">Set limit</button>
            </div>
            {seatUsage ? (
              <dl className="text-sm space-y-1.5">
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Used</dt>
                  <dd className="font-mono text-xs">
                    {seatUsage.used} / {seatUsage.limit === -1 ? '∞' : seatUsage.limit}
                  </dd>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 pt-1">
                  Pooled across the whole account (active members + pending invites).
                  {seatUsage.limit === -1 ? ' Seats are unlimited.' : ''}
                </p>
              </dl>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Seat usage unavailable for this org. It may not be an account root,
                or the seat service didn&apos;t respond.
              </p>
            )}
          </Card>

          {/* Feature entitlements card — read-only. The account's (root) pooled
              feature flags purchased via tier + add-on bundles. */}
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-5 h-5 text-gray-500" />
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Feature entitlements</h3>
            </div>
            {features.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {features.map((f) => (
                  <Badge key={f} color="blue">{f}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No add-on feature entitlements. The org has only its tier&apos;s baseline features.
              </p>
            )}
          </Card>

          {/* Quotas card */}
          {org.quotas && (
            <Card>
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
            </Card>
          )}
        </div>
        )}

        {activeTab === 'operations' && (
        <div className="grid grid-cols-1 gap-4">
          {/* Operations card — destructive + scaffolding actions */}
          <Card>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Operations</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={downloadNamespaceYaml} className="inline-flex items-center gap-2 text-sm">
                <FileDown className="w-4 h-4" /> Download k8s namespace YAML
              </Button>
              <Button variant="secondary" onClick={handleExport} disabled={exporting} className="inline-flex items-center gap-2 text-sm disabled:opacity-60">
                <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export data'}
              </Button>
              <LinkButton href={`/dashboard/audit?affectedOrgId=${org.id}`} variant="secondary" className="text-sm">
                View audit log
              </LinkButton>
              <div className="flex-1" />
              <Button variant="danger" onClick={() => setShowDelete(true)} className="inline-flex items-center gap-2 text-sm">
                <Trash2 className="w-4 h-4" /> Delete organization
              </Button>
            </div>
          </Card>
        </div>
        )}
        </>
      )}

      {showEdit && org && (
        <Modal
          title="Edit organization"
          onClose={() => setShowEdit(false)}
          maxWidth="max-w-md"
          footer={
            <ModalFooter
              onCancel={() => setShowEdit(false)}
              onConfirm={handleSaveIdentity}
              confirmLabel="Save"
              loading={editForm.loading}
            />
          }
        >
          <div className="space-y-4">
            <ErrorAlert message={editForm.error} />
            <div>
              <label htmlFor="org-name" className="label">Name</label>
              <Input id="org-name" value={editName} onChange={(e) => setEditName(e.target.value)} disabled={editForm.loading} />
            </div>
            <div>
              <label htmlFor="org-slug" className="label">Slug</label>
              <Input
                id="org-slug"
                value={editSlug}
                onChange={(e) => setEditSlug(e.target.value)}
                disabled={editForm.loading}
                placeholder="my-org"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Lowercase alphanumeric with hyphens (e.g. <code>my-org</code>).
              </p>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Description isn&apos;t editable here — the update endpoint only accepts name and slug.
            </p>
          </div>
        </Modal>
      )}

      {showSeatLimit && org && (
        <Modal
          title="Set seat limit"
          onClose={() => setShowSeatLimit(false)}
          maxWidth="max-w-md"
          footer={
            <ModalFooter
              onCancel={() => setShowSeatLimit(false)}
              onConfirm={handleSaveSeatLimit}
              confirmLabel="Save"
              loading={seatForm.loading}
            />
          }
        >
          <div className="space-y-4">
            <ErrorAlert message={seatForm.error} />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Sets the pooled seat cap for the whole account (applied to the root org).
              Seats count active members plus pending invites across every team.
            </p>
            <div>
              <label htmlFor="seat-limit" className="label">Seats</label>
              <Input
                id="seat-limit"
                type="number"
                min={0}
                step={1}
                value={seatLimitInput}
                onChange={(e) => setSeatLimitInput(e.target.value)}
                disabled={seatForm.loading || seatUnlimited}
                placeholder="e.g. 25"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <Checkbox
                checked={seatUnlimited}
                onChange={(e) => setSeatUnlimited(e.target.checked)}
                disabled={seatForm.loading}
              />
              Unlimited seats
            </label>
          </div>
        </Modal>
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
