// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { CatalogFieldEditor, type CatalogEditorField } from '@/components/plugin/CatalogFieldEditor';
import api from '@/lib/api';
import { applyCatalogEdits } from '@/lib/ecosystem';
import type { PluginCatalogEdits } from '@/types';
import type { ListingView } from '@/types/ecosystem';
import { ListingCardPreview } from './ListingCardPreview';
import { describePublishError } from './PublishRequestForm';

/** The listing's current descriptive values, as editor rows (no detected source). */
export function listingCatalogFields(listing: ListingView): CatalogEditorField[] {
  return [
    { field: 'summary', value: listing.summary, source: null },
    { field: 'description', value: listing.description, source: null },
    { field: 'category', value: listing.category, source: null },
    { field: 'keywords', value: listing.keywords, source: null },
    { field: 'license', value: listing.license, source: null },
    { field: 'homepageUrl', value: listing.homepageUrl, source: null },
    { field: 'sourceUrl', value: listing.sourceUrl, source: null },
    { field: 'icon', value: listing.icon, source: null },
  ];
}

/**
 * Start a `listing_update` request from the listing itself,
 * pre-filled with the current values. Only the fields the publisher changes are
 * sent; the live card preview shows the result.
 */
export function RequestListingUpdateDialog({ listing, onClose, onSubmitted }: {
  listing: ListingView;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [edits, setEdits] = useState<PluginCatalogEdits>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = listingCatalogFields(listing);
  const dirty = Object.keys(edits).length > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.submitPublishRequest({ kind: 'listing_update', listingId: listing.id, metadata: edits });
      onSubmitted();
      onClose();
    } catch (err) {
      setError(describePublishError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Request a listing update: ${listing.name}`}
      onClose={onClose}
      maxWidth="max-w-4xl"
      tall
      dirty={dirty}
      footer={(
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void submit()}
          confirmLabel="Submit update request"
          loading={busy}
          confirmDisabled={!dirty}
        />
      )}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <CatalogFieldEditor
          fields={fields}
          edits={edits}
          onEditsChange={setEdits}
          disabled={busy}
          heading="Listing details"
          headingId="listing-update-heading"
          description="Current values of the live listing. Edit the ones to change; the ecosystem team reviews the update."
        />
        <ListingCardPreview
          name={listing.name}
          version={listing.latestVersion ?? '0.0.0'}
          values={applyCatalogEdits(fields, edits)}
          publisher={{ handle: listing.publisherHandle, displayName: listing.publisherHandle, tier: listing.publisherTier }}
        />
      </div>
      <ErrorAlert message={error} onDismiss={() => setError(null)} className="mt-3" />
    </Modal>
  );
}
