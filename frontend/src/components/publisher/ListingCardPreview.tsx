// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ListingCardView } from '@/components/public-directory/ListingCardView';
import { vendorDisclaimer } from '@/lib/public-directory/listing';
import { buildPreviewCard } from '@/lib/ecosystem';

type PreviewInput = Parameters<typeof buildPreviewCard>[0];

/**
 * Live preview of the public directory card a listing will render as: the
 * directory's own `ListingCardView`, fed the effective
 * values, so the icon, tier badge and summary are exactly what installers will
 * see. `inert` — the card's link points at a page that doesn't exist yet.
 */
export function ListingCardPreview(props: PreviewInput) {
  const card = buildPreviewCard(props);
  const disclaimer = vendorDisclaimer({ iconKind: card.iconKind, iconKey: card.iconKey, publisher: card.publisher });
  return (
    <figure className="space-y-2" data-testid="listing-card-preview" aria-label="Directory card preview">
      <figcaption className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Directory card preview</figcaption>
      <div inert className="max-w-sm">
        <ListingCardView listing={card} />
      </div>
      {!card.summary && <p className="text-xs text-warning-strong">No summary yet — the card will show an empty line.</p>}
      {disclaimer && <p className="text-xs text-fg-muted">{disclaimer}</p>}
    </figure>
  );
}
