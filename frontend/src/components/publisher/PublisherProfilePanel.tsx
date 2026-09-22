// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { BadgeCheck, FileSignature, IdCard, PenLine, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { SectionCard } from '@/components/ui/SectionCard';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { EcosystemActionDialog } from '@/components/ecosystem/EcosystemActionDialog';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { formatListingsQuota, isListingsQuotaFull } from '@/lib/ecosystem';
import type { PublisherContext } from '@/types/ecosystem';
import { describePublishError } from './PublishRequestForm';

/** Light client check only — the server validates handles. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface Props {
  ctx: PublisherContext;
  /** `publishers:manage`: create the profile, accept terms, edit it, submit profile requests. */
  canManage: boolean;
  onChanged: () => void;
}

/** Claim a handle and create the publisher profile (terms acceptance included). */
function CreatePublisherForm({ ctx, canManage, onChanged }: Props) {
  const toast = useToast();
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reserved, setReserved] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  const handleOk = HANDLE_PATTERN.test(handle.trim());
  const canSubmit = canManage && handleOk && !!displayName.trim() && terms && !busy;

  const create = async () => {
    setBusy(true);
    setError(null);
    setReserved(null);
    try {
      await api.createPublisher({
        handle: handle.trim(),
        displayName: displayName.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(homepageUrl.trim() ? { homepageUrl: homepageUrl.trim() } : {}),
        termsVersion: ctx.terms.currentVersion,
      });
      toast.success(`Publisher ${handle.trim()} created`);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PUBLISHER_HANDLE_RESERVED') setReserved(handle.trim());
      else if (err instanceof ApiError && err.code === 'DUPLICATE_ENTRY') setError('That handle is already taken. Choose another.');
      else setError(describePublishError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard icon={IdCard} title="Create your publisher" description="Your organization's public identity in the plugin directory. One publisher per organization.">
      <div className="space-y-4 max-w-xl">
        <FormField label="Handle" required hint="Lowercase letters, digits and dashes. Shown in listing URLs, e.g. /plugins/acme/my-plugin.">
          <Input value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} disabled={!canManage || busy} placeholder="acme" />
        </FormField>
        <FormField label="Display name" required>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={!canManage || busy} placeholder="Acme Corp" />
        </FormField>
        <FormField label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canManage || busy} />
        </FormField>
        <FormField label="Homepage URL" hint="An https:// link.">
          <Input value={homepageUrl} onChange={(e) => setHomepageUrl(e.target.value)} disabled={!canManage || busy} placeholder="https://example.com" />
        </FormField>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={terms} onChange={(e) => setTerms(e.target.checked)} disabled={!canManage || busy} />
          <span>I accept the publisher terms (version {ctx.terms.currentVersion}) on behalf of my organization.</span>
        </label>

        {reserved && (
          <Callout variant="warning" title="That handle is reserved">
            <p>
              &ldquo;{reserved}&rdquo; is reserved, usually for a known project or vendor. If it belongs to your organization,
              request it: the ecosystem team reviews the claim.
            </p>
            <div className="mt-2">
              <Button size="xs" variant="secondary" onClick={() => setClaiming(true)}>Request this handle</Button>
            </div>
          </Callout>
        )}
        <ErrorAlert message={error} onDismiss={() => setError(null)} />

        {!canManage && <p className="text-xs text-fg-muted">Creating the publisher needs the publishers:manage permission.</p>}
        <Button onClick={() => void create()} loading={busy} disabled={!canSubmit}>Create publisher</Button>
      </div>

      {claiming && reserved && (
        <EcosystemActionDialog
          title="Request a reserved handle"
          action={`Claim the handle ${reserved}`}
          details={<p>Explain why the handle belongs to your organization (the project you maintain, your domain, …).</p>}
          reasonLabel="Why this handle is yours"
          reasonRequired
          stepUp={false}
          confirmLabel="Submit claim"
          onSubmit={async (reason) => {
            try {
              await api.submitPublishRequest({ kind: 'claim', target: { handle: reserved }, reason });
            } catch (err) {
              throw new Error(describePublishError(err).message);
            }
            toast.success('Claim submitted. The ecosystem team will review it.');
            onChanged();
          }}
          onClose={() => setClaiming(false)}
        />
      )}
    </SectionCard>
  );
}

type ProfileDialog = 'profile_change' | 'verify' | null;

/**
 * The org's publisher profile (plan §3.1): tier, terms, direct edits of the
 * description and homepage, and REQUESTS for everything the system org decides
 * — handle and display-name changes, and Verified status (Team+ only).
 */
export function PublisherProfilePanel({ ctx, canManage, onChanged }: Props) {
  const toast = useToast();
  const p = ctx.publisher;
  const [description, setDescription] = useState(p?.description ?? '');
  const [homepageUrl, setHomepageUrl] = useState(p?.homepageUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [acceptingTerms, setAcceptingTerms] = useState(false);
  const [dialog, setDialog] = useState<ProfileDialog>(null);
  const [newHandle, setNewHandle] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [domain, setDomain] = useState('');

  if (!ctx.publishingEnabled) {
    return (
      <Callout variant="neutral" title="Publishing is turned off">
        Publishing to the plugin ecosystem is disabled on this instance. Installing listings is unaffected.
      </Callout>
    );
  }

  const teamNotice = !ctx.isRootOrg && (
    <Callout variant="info" title="Publishing happens from your root organization">
      This organization is a team. Publisher profiles and publish requests belong to the root organization: move or upload
      the plugin there, and ask a root-organization admin to submit it.
    </Callout>
  );

  if (!p) {
    return (
      <div className="space-y-4">
        {teamNotice}
        {ctx.isRootOrg && <CreatePublisherForm ctx={ctx} canManage={canManage} onChanged={onChanged} />}
      </div>
    );
  }

  const quotaFull = isListingsQuotaFull(ctx.listingsQuota);
  const dirty = (description.trim() || null) !== (p.description ?? null) || (homepageUrl.trim() || null) !== (p.homepageUrl ?? null);
  const writable = canManage && ctx.isRootOrg;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.updatePublisher({ description: description.trim() || null, homepageUrl: homepageUrl.trim() || null });
      toast.success('Publisher profile saved');
      onChanged();
    } catch (err) {
      setSaveError(formatError(err, 'Could not save the profile'));
    } finally {
      setSaving(false);
    }
  };

  const acceptTerms = async () => {
    setAcceptingTerms(true);
    try {
      await api.acceptPublisherTerms(ctx.terms.currentVersion);
      toast.success('Publisher terms accepted');
      onChanged();
    } catch (err) {
      toast.error(formatError(err, 'Could not accept the terms'));
    } finally {
      setAcceptingTerms(false);
    }
  };

  const submitRequest = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn();
    } catch (err) {
      throw new Error(describePublishError(err).message);
    }
    toast.success(`${what} requested. The ecosystem team will review it.`);
    onChanged();
  };

  const alreadyVerified = p.tier === 'verified' || p.tier === 'official';

  return (
    <div className="space-y-4">
      {teamNotice}

      {!ctx.terms.accepted && (
        <Callout variant="warning" icon={FileSignature} title="The publisher terms have changed">
          <p>Accept version {ctx.terms.currentVersion} to submit new requests. Your existing listings are unaffected.</p>
          {writable && (
            <div className="mt-2">
              <Button size="xs" onClick={() => void acceptTerms()} loading={acceptingTerms}>Accept the new terms</Button>
            </div>
          )}
        </Callout>
      )}

      {p.suspendedAt && (
        <Callout variant="danger" title="This publisher is suspended">
          {p.suspendReason ?? 'Contact support for details.'} New requests are refused while the suspension lasts.
        </Callout>
      )}

      <SectionCard
        icon={IdCard}
        title={p.displayName}
        description={<span className="font-mono">@{p.handle}</span>}
        actions={<TrustTierBadge tier={p.tier} />}
      >
        <div className="space-y-4 max-w-xl">
          <p className="text-sm text-fg-muted" data-testid="listings-quota">
            Listings used: <span className="font-medium text-fg">{formatListingsQuota(ctx.listingsQuota)}</span>
            {quotaFull && ' — the limit is reached; new-listing requests are refused until you upgrade or retire a listing.'}
          </p>
          <FormField label="Description">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!writable || saving} />
          </FormField>
          <FormField label="Homepage URL" hint="An https:// link.">
            <Input value={homepageUrl} onChange={(e) => setHomepageUrl(e.target.value)} disabled={!writable || saving} />
          </FormField>
          <ErrorAlert message={saveError} onDismiss={() => setSaveError(null)} />
          {writable && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save()} loading={saving} disabled={!dirty || saving}>Save</Button>
              <Button variant="secondary" onClick={() => setDialog('profile_change')}>
                <PenLine className="w-4 h-4 mr-1" aria-hidden />Request handle or name change
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      {!alreadyVerified && (
        <SectionCard icon={BadgeCheck} title="Verified publisher" description="A Verified badge on every listing, awarded after a review by the ecosystem team.">
          {ctx.verifiedEligible ? (
            <div className="space-y-2 text-sm text-fg-muted">
              <p>Requirements: a verified domain on your organization and two-factor sign-in for the owner.</p>
              {writable && (
                <Button variant="secondary" onClick={() => setDialog('verify')}>
                  <ShieldCheck className="w-4 h-4 mr-1" aria-hidden />Apply for Verified
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2 text-sm text-fg-muted">
              <p>Verified status is available to organizations on the Team and Enterprise plans. It is earned through review, never purchased.</p>
              <Button variant="secondary" disabled title="Available on Team and Enterprise plans">
                <ShieldCheck className="w-4 h-4 mr-1" aria-hidden />Apply for Verified
              </Button>
            </div>
          )}
        </SectionCard>
      )}

      {dialog === 'profile_change' && (
        <EcosystemActionDialog
          title="Request a profile change"
          action={`Change the handle or display name of @${p.handle}`}
          details={(
            <>
              <p>Handles and display names can be used to impersonate other projects, so the ecosystem team approves every change.</p>
              <FormField label="New handle (optional)">
                <Input value={newHandle} onChange={(e) => setNewHandle(e.target.value.toLowerCase())} placeholder={p.handle} />
              </FormField>
              <FormField label="New display name (optional)">
                <Input value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} placeholder={p.displayName} />
              </FormField>
            </>
          )}
          reasonLabel="Reason (optional)"
          stepUp={false}
          confirmLabel="Submit request"
          onSubmit={(reason) => submitRequest(async () => {
            const target = {
              ...(newHandle.trim() ? { handle: newHandle.trim() } : {}),
              ...(newDisplayName.trim() ? { displayName: newDisplayName.trim() } : {}),
            };
            if (!target.handle && !target.displayName) throw new Error('Enter a new handle or display name.');
            await api.submitPublishRequest({ kind: 'profile_change', target, ...(reason ? { reason } : {}) });
          }, 'Profile change')}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'verify' && (
        <EcosystemActionDialog
          title="Apply for Verified"
          action={`Apply for Verified status for @${p.handle}`}
          details={(
            <FormField label="Verified domain" hint="A domain your organization has verified (Settings, then Organization).">
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
            </FormField>
          )}
          reasonLabel="Notes for the reviewers (optional)"
          stepUp={false}
          confirmLabel="Submit application"
          onSubmit={(notes) => submitRequest(async () => {
            try {
              await api.submitPublishRequest({
                kind: 'verify',
                application: { ...(domain.trim() ? { domain: domain.trim() } : {}), ...(notes ? { notes } : {}) },
              });
            } catch (err) {
              // Below Team the route refuses with INSUFFICIENT_PERMISSIONS (the
              // plan, not the person) — say which.
              if (err instanceof ApiError && err.code === 'INSUFFICIENT_PERMISSIONS') {
                throw new Error('Verified status is available on the Team and Enterprise plans.');
              }
              throw err;
            }
          }, 'Verified status')}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
