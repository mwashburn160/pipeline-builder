// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Is this yours?" — the claim control for a COMMUNITY listing.
 *
 * Anonymous submissions land under the platform's community publisher, so a
 * maintainer whose plugin was submitted for them has no way to take it over
 * from the surface where they would discover it: their own plugin's page.
 *
 * The backend has accepted `kind: 'claim'` on a community listing all along,
 * and the moderator console already renders the whole decision side of it —
 * `needsJustification`, the claimant-email-match notice that exists so approval
 * can link the listing's anonymous submissions to the claimer's account. The
 * only missing piece was a way to CREATE the request; the review flow had no
 * reachable source.
 *
 * Shown only on a community listing, and only to a signed-in viewer: claiming
 * needs a publisher to claim INTO, and the request carries the claimant's
 * verified email (hashed) so the link can be made.
 */

import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EcosystemActionDialog } from '@/components/ecosystem/EcosystemActionDialog';
import { useToast } from '@/components/ui/Toast';
import { describePublishError } from '@/components/publisher/PublishRequestForm';
import api from '@/lib/api';

/** The community publisher's handle — listings under it are the claimable ones. */
export const COMMUNITY_PUBLISHER = 'community';

export function ClaimListingNotice({ listingName, signedIn, loginHref }: {
  listingName: string;
  signedIn: boolean;
  loginHref: string;
}) {
  const toast = useToast();
  const [claiming, setClaiming] = useState(false);

  return (
    <>
      <Callout variant="info" title="Maintained by the community">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            This plugin was submitted to the directory rather than published by its maintainer.
            If it is yours, claim it to publish future versions under your own publisher.
          </p>
          {signedIn ? (
            <Button size="xs" variant="secondary" onClick={() => setClaiming(true)}>
              <BadgeCheck className="mr-1 h-3.5 w-3.5" aria-hidden />Claim this listing
            </Button>
          ) : (
            // Not hidden: a signed-out maintainer should learn the path exists.
            <Button size="xs" variant="secondary" onClick={() => { window.location.href = loginHref; }}>
              Sign in to claim
            </Button>
          )}
        </div>
      </Callout>

      {claiming && (
        <EcosystemActionDialog
          title="Claim this listing"
          action={`Claim ${listingName}`}
          details={(
            <p>
              Explain how this plugin is yours — the repository you maintain, your domain, the
              release you publish. Approval moves the listing to your publisher and links the
              submissions made under it to your account.
            </p>
          )}
          reasonLabel="Why this listing is yours"
          reasonRequired
          stepUp={false}
          confirmLabel="Submit claim"
          onSubmit={async (reason) => {
            try {
              await api.submitPublishRequest({ kind: 'claim', target: { name: listingName }, reason });
            } catch (err) {
              throw new Error(describePublishError(err).message);
            }
            toast.success('Claim submitted. The ecosystem team will review it.');
            setClaiming(false);
          }}
          onClose={() => setClaiming(false)}
        />
      )}
    </>
  );
}
