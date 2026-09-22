// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { CheckCircle2, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { RetryError } from '@/components/ui/RetryError';
import { useToast } from '@/components/ui/Toast';
import { CatalogFieldEditor } from '@/components/plugin/CatalogFieldEditor';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { applyCatalogEdits, formatListingsQuota } from '@/lib/ecosystem';
import type { PluginCatalogEdits, PluginCatalogField, PluginMetadataSource } from '@/types';
import type { PublishDraft, PublishGate } from '@/types/ecosystem';
import { ListingCardPreview } from './ListingCardPreview';
import { ListingUpdateOffer } from './ListingUpdateOffer';

/** A submit failure in words the publisher can act on (contract error codes). */
export function describePublishError(err: unknown): { message: string; gates?: PublishGate[] } {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'PUBLISH_GATE_FAILED':
        return {
          message: 'Some publishing checks failed. Fix them and submit again.',
          gates: Array.isArray(err.details?.gates) ? err.details.gates as PublishGate[] : undefined,
        };
      case 'QUOTA_EXCEEDED':
        return { message: 'Your plan’s listings limit is reached. Upgrade the plan or retire a listing first.' };
      case 'PUBLISHER_REQUIRED':
        return { message: 'Create your publisher profile first (Profile tab).' };
      case 'PUBLISHER_TERMS_REQUIRED':
        return { message: 'Accept the current publisher terms first (Profile tab).' };
      case 'PUBLISHER_ROOT_ORG_REQUIRED':
        return { message: 'Publishing happens from your root organization, not a team.' };
      case 'PUBLISHER_SUSPENDED':
        return { message: 'Your publisher is suspended; new requests are refused.' };
      case 'PLUGIN_PUBLISHING_DISABLED':
        return { message: 'Publishing to the ecosystem is turned off on this instance.' };
      case 'DUPLICATE_ENTRY':
        return { message: err.message || 'An open request of this kind already exists.' };
      default:
        break;
    }
  }
  return { message: formatError(err, 'The request could not be submitted') };
}

/**
 * Provenance for the offer fields the publisher ACCEPTED as detected (the draft's
 * source for that field). Edited fields are left out — the server records them
 * as `user`, which is what the review diff highlights.
 */
export function acceptedOfferSources(
  draft: Pick<PublishDraft, 'metadata' | 'listingUpdateOffer'>,
  offerEdits: PluginCatalogEdits,
): Partial<Record<PluginCatalogField, PluginMetadataSource>> {
  const out: Partial<Record<PluginCatalogField, PluginMetadataSource>> = {};
  for (const offered of draft.listingUpdateOffer) {
    if (!Object.prototype.hasOwnProperty.call(offerEdits, offered.field)) continue;
    const accepted = JSON.stringify(offerEdits[offered.field] ?? null) === JSON.stringify(offered.value ?? null);
    const source = draft.metadata.find((m) => m.field === offered.field)?.source;
    if (accepted && source) out[offered.field] = source;
  }
  return out;
}

function GateList({ gates }: { gates: readonly PublishGate[] }) {
  return (
    <ul className="space-y-1" aria-label="Publishing checks">
      {gates.map((g) => (
        <li key={g.id} className="flex items-start gap-2 text-sm" data-gate={g.id} data-ok={g.ok}>
          {g.ok
            ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Passed" />
            : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Failed" />}
          <span className={g.ok ? 'text-fg-muted' : 'text-fg'}>{g.message}</span>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  pluginId: string;
  onSubmitted: () => void;
}

/**
 * Submit a `new_listing` or `new_version` request for one of the org's plugin
 * versions (plan §3.1, §3.1a). The server's draft decides which, lists the
 * gates (a failing gate blocks submit) and pre-fills the catalog fields:
 *
 *  - new listing: the accept-or-edit field list plus a live directory-card
 *    preview; only EDITED fields travel as `metadata`;
 *  - new version: when the version's detected metadata differs from the live
 *    listing, the changed-fields-only `listing_update` offer. Accepting any of
 *    it submits a SEPARATE `listing_update` request after the version's.
 */
export function PublishRequestForm({ pluginId, onSubmitted }: Props) {
  const toast = useToast();
  const draftQ = useFetch(async (signal): Promise<PublishDraft> => {
    const res = await api.getPublishDraft(pluginId, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Could not prepare the request');
    return res.data;
  }, [pluginId]);
  const draft = draftQ.data;

  const [edits, setEdits] = useState<PluginCatalogEdits>({});
  const [offerEdits, setOfferEdits] = useState<PluginCatalogEdits>({});
  const [breaking, setBreaking] = useState<boolean | null>(null);
  const [advisoryId, setAdvisoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; gates?: PublishGate[] } | null>(null);

  if (draftQ.loading && !draft) return <Skeleton className="h-40 w-full" />;
  if (draftQ.error || !draft) {
    return <RetryError message={describePublishError(draftQ.error).message} onRetry={draftQ.refetch} />;
  }

  const failing = draft.gates.filter((g) => !g.ok);
  const isNewListing = draft.kind === 'new_listing';
  const isBreaking = breaking ?? draft.plugin.breaking;
  const publisher = draft.publisher
    ? { handle: draft.publisher.handle, displayName: draft.publisher.displayName, tier: draft.publisher.tier }
    : null;

  const previewValues = isNewListing
    ? applyCatalogEdits(draft.metadata, edits)
    : applyCatalogEdits(
      draft.metadata.map((f) => ({ field: f.field, value: f.current ?? f.value })),
      offerEdits,
    );

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = isNewListing
        ? await api.submitPublishRequest({
          kind: 'new_listing',
          pluginId,
          ...(Object.keys(edits).length ? { metadata: edits } : {}),
          ...(advisoryId.trim() ? { securityFixAdvisoryId: advisoryId.trim() } : {}),
        })
        : await api.submitPublishRequest({
          kind: 'new_version',
          pluginId,
          breaking: isBreaking,
          ...(advisoryId.trim() ? { securityFixAdvisoryId: advisoryId.trim() } : {}),
        });
      toast.success(res.data?.autoApproved
        ? 'Approved automatically by an auto-approval rule.'
        : 'Request submitted. The ecosystem team will review it.');

      if (!isNewListing && draft.listing && Object.keys(offerEdits).length > 0) {
        try {
          const sources = acceptedOfferSources(draft, offerEdits);
          await api.submitPublishRequest({
            kind: 'listing_update',
            listingId: draft.listing.id,
            metadata: offerEdits,
            ...(Object.keys(sources).length ? { sources } : {}),
          });
          toast.success('Listing update requested.');
        } catch (err) {
          toast.error(`The version was submitted, but the listing update was not: ${describePublishError(err).message}`);
        }
      }
      onSubmitted();
    } catch (err) {
      setError(describePublishError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="publish-request-form">
      <div>
        <h3 className="text-base font-semibold text-fg">
          {isNewListing ? 'New listing' : `New version of ${draft.listing?.name ?? draft.plugin.name}`}
          <span className="ml-2 font-mono text-sm text-fg-muted">{draft.plugin.name} v{draft.plugin.version}</span>
        </h3>
        <p className="text-xs text-fg-muted">
          The request pins this version&apos;s image digest. It is reviewed by the ecosystem team before anything is listed.
          {isNewListing && <> Listings used: {formatListingsQuota(draft.listingsQuota)}.</>}
        </p>
      </div>

      <section aria-labelledby="publish-gates-heading" className="space-y-2">
        <h4 id="publish-gates-heading" className="text-sm font-semibold text-fg">Checks</h4>
        <GateList gates={draft.gates} />
        {failing.length > 0 && (
          <Callout variant="warning" title="This version can't be submitted yet">
            {failing.length === 1 ? 'One check is failing.' : `${failing.length} checks are failing.`} Fix them and reopen this form.
          </Callout>
        )}
      </section>

      {isNewListing ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <CatalogFieldEditor
            fields={draft.metadata.map((f) => ({ field: f.field, value: f.value, source: f.source }))}
            edits={edits}
            onEditsChange={setEdits}
            disabled={busy}
            heading="Listing details"
            headingId="publish-listing-details-heading"
            description="Pre-filled from this version. Accept each value or edit it; the reviewers see which values you edited."
            testId="publish-listing-details"
          />
          <ListingCardPreview name={draft.plugin.name} version={draft.plugin.version} values={previewValues} publisher={publisher} />
        </div>
      ) : (
        <>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={isBreaking} onChange={(e) => setBreaking(e.target.checked)} disabled={busy} />
            <span>
              <span className="font-medium text-fg">Breaking change</span>
              <span className="block text-xs text-fg-muted">
                Breaking versions never flow automatically to installs that follow a version range.
              </span>
            </span>
          </label>
          {draft.listingUpdateOffer.length > 0 && (
            <section aria-labelledby="publish-offer-heading" className="space-y-2">
              <h4 id="publish-offer-heading" className="text-sm font-semibold text-fg">Update the listing too?</h4>
              <p className="text-xs text-fg-muted">
                This version&apos;s details differ from the live listing. Accept or edit the fields you want to change; the rest
                keep their current value. Accepted changes are submitted as a separate listing-update request.
              </p>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <ListingUpdateOffer offer={draft.listingUpdateOffer} edits={offerEdits} onEditsChange={setOfferEdits} disabled={busy} />
                <ListingCardPreview name={draft.listing?.name ?? draft.plugin.name} version={draft.plugin.version} values={previewValues} publisher={publisher} />
              </div>
            </section>
          )}
        </>
      )}

      <FormField
        label="Fixes a published advisory (optional)"
        hint="An advisory ID. Security fixes go to the priority lane."
      >
        <Input value={advisoryId} onChange={(e) => setAdvisoryId(e.target.value)} disabled={busy} placeholder="Advisory ID" />
      </FormField>

      {error && (
        <div className="space-y-2">
          <ErrorAlert message={error.message} onDismiss={() => setError(null)} />
          {error.gates && error.gates.length > 0 && <GateList gates={error.gates} />}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void submit()} loading={busy} disabled={failing.length > 0 || busy}>
          <Send className="w-4 h-4 mr-1" aria-hidden />
          {isNewListing ? 'Submit listing request' : 'Submit version request'}
        </Button>
      </div>
    </div>
  );
}
