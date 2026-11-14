// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 3 — the DELIVERY leg (docs/plans/sales-agent.md).
 *
 * Phase 2 decides; this is the only place an account actually hears about it —
 * over the two surfaces quota pressure ALREADY uses, the org inbox and the email
 * relay, rather than a third one the account has to learn.
 *
 * Three things are load-bearing and each is here rather than at the call site,
 * because each was a way the feature could have shipped looking fine:
 *
 * 1. **The consent AND (D6).** An offer is sent only when the account's own
 *    `offersEnabled` AND its quota-notice switch are both on. The notice switch
 *    counts because this offer rides the quota channel: an account that turned
 *    usage email off has already said what it wants from this channel, and
 *    treating an advert as exempt from that would be the one reading of "same
 *    channel" nobody asked for. Platform does NOT re-check it — it owns neither
 *    switch — so if this check is missing, nothing else stops the mail.
 *
 * 2. **Copy that names the LIMIT and the PRICE.** `offerEmailText` returns
 *    `null` when it cannot do both, and a null is a refusal to send. An offer
 *    that says "you're running out, talk to sales" is the spam version of this
 *    feature; the account should be able to decide from the mail alone, which
 *    means the dimension, where it stands against its cap, what the fix is and
 *    what it costs — the same figures its quota card already shows (F2), so the
 *    mail and the dashboard cannot disagree.
 *
 * 3. **It is BEST EFFORT and never thrown.** A relay failure must not fail the
 *    cycle or lose the decision row — the row is the thing the measurement
 *    phase counts, and an exception here would roll back the account's turn and
 *    offer it again next cycle.
 */

import {
  createLogger,
  createSafeClient,
  emitCounter,
  errorMessage,
  formatQuotaAmount,
  getServiceAuthHeader,
  NOTIFY_EMAIL_PATH,
  quotaLabelPlural,
  sendSystemNotification,
  serviceEndpoint,
  type BillingInterval,
} from '@pipeline-builder/api-core';
import type { OfferType } from '../models/offer.js';

const logger = createLogger('offers-notify');

/** Where an account goes to act on any of this. One path, so the mail, the card and the banner agree. */
export const OFFER_LANDING_PATH = '/dashboard/quotas';

/**
 * The two switches D6 ANDs. Both arrive on the profile read billing already
 * makes (`UsageProfileRead`), which is why this phase opened no second route:
 * a consent check that needs its own fetch is a consent check that gets skipped
 * when the fetch fails.
 */
export interface OfferConsent {
  /** The account's own offers switch. Absent upstream reads as true (opt-OUT). */
  accountOptIn: boolean;
  /** The account's quota-notice switch. Off means this CHANNEL is off. */
  noticesEnabled: boolean;
}

/** D6's AND, in one place so no caller can apply half of it. */
export function offerChannelAllowed(consent: OfferConsent): boolean {
  return consent.accountOptIn && consent.noticesEnabled;
}

/** One dimension the offer is argued from. */
export interface PressurePoint {
  dimension: string;
  used: number;
  limit: number;
}

/** The pack the offer quotes — the SAME pack the quota card quotes (F2). */
export interface QuotedPack {
  name: string;
  priceCents: number;
  /** "10", "50 GB" — what the pack adds, already in its display unit. */
  grantDisplay: string;
}

export interface OfferEmailFacts {
  offerType: OfferType;
  /** Dimensions under pressure, strongest first. Empty ⇒ nothing to name. */
  pressure: readonly PressurePoint[];
  /** The pack to quote, for a `pack`/`compose` offer. */
  pack?: QuotedPack | null;
  /** For an `upgrade`: the tier the account would move to. */
  candidateTier?: string | null;
  /** For an `upgrade`: what the move SAVES per interval, in cents. */
  savingCents?: number;
  interval: BillingInterval;
  /** When the offer lapses, so the mail says it rather than implying forever. */
  expiresAt?: Date | null;
}

/** `$12.99`, `$300` — cents in, no trailing `.00`. */
export function money(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rem = Math.abs(cents % 100);
  return rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, '0')}`;
}

/** "9 of 10 pipelines" — the dimension, where it stands, in the dimension's own unit. */
function standing(p: PressurePoint): string {
  const used = formatQuotaAmount(p.dimension, p.used);
  const limit = formatQuotaAmount(p.dimension, p.limit);
  return `${used} of ${limit} ${quotaLabelPlural(p.dimension).toLowerCase()}`;
}

/**
 * The mail, or `null` when the facts cannot name both a limit and a price.
 *
 * Null is a REFUSAL, not an empty render: the caller must suppress rather than
 * send something vaguer. Every branch below therefore ends in copy that carries
 * a figure the account can check against its own dashboard.
 */
export function offerEmailText(facts: OfferEmailFacts): { subject: string; text: string } | null {
  const per = facts.interval === 'annual' ? 'year' : 'month';
  const expiry = facts.expiresAt
    ? `\n\nThis is available until ${facts.expiresAt.toISOString().slice(0, 10)}.`
    : '';
  const footer = `\n\nYou can review your usage and change this at ${OFFER_LANDING_PATH}.`
    + '\nTo stop messages like this, turn off offers in your organization\'s notification settings.';

  if (facts.offerType === 'upgrade') {
    // The CROSSOVER mail. Its "price" is a NEGATIVE number — the account is
    // already paying more than the plan costs — so it needs no pack and no
    // discount, and a saving of zero is not an argument worth mailing.
    const saving = facts.savingCents ?? 0;
    if (!facts.candidateTier || saving <= 0) return null;
    const lead = facts.pressure.length > 0
      ? `You're at ${standing(facts.pressure[0]!)}, and your add-ons now cost more than the plan that includes them.`
      : 'Your add-ons now cost more than the plan that includes them.';
    return {
      subject: `You could pay ${money(saving)} less per ${per}`,
      text: `${lead}\n\n`
        + `Moving to ${facts.candidateTier} would lower your bill by ${money(saving)} per ${per} `
        + `and keep the capacity you're using today.${expiry}${footer}`,
    };
  }

  // A pack or a basket. Both need a price; neither is worth mailing without one.
  if (!facts.pack || facts.pack.priceCents <= 0 || facts.pressure.length === 0) return null;
  const { name, priceCents, grantDisplay } = facts.pack;

  if (facts.offerType === 'compose') {
    // THREE dimensions at once is the shape that argues for a basket rather
    // than a pack, so the mail names all of them — an account told only about
    // the loudest one solves a third of its problem and is asked again.
    const list = facts.pressure.map(standing).join(', ');
    return {
      subject: `You're close to ${facts.pressure.length} of your limits`,
      text: `You're at ${list}.\n\n`
        + `${name} adds ${grantDisplay} for ${money(priceCents)} per ${per}, `
        + `and you can add capacity on the other limits in the same step.${expiry}${footer}`,
    };
  }

  const p = facts.pressure[0]!;
  return {
    subject: `You're close to your ${quotaLabelPlural(p.dimension).toLowerCase()} limit`,
    text: `You're at ${standing(p)}.\n\n`
      + `${name} adds ${grantDisplay} for ${money(priceCents)} per ${per}.${expiry}${footer}`,
  };
}

let platformClient: ReturnType<typeof createSafeClient> | null = null;
function platform(): ReturnType<typeof createSafeClient> {
  platformClient ??= createSafeClient({ ...serviceEndpoint('platform'), timeout: 5000 });
  return platformClient;
}

/** Why an offer mail did not go out, for the per-reason counter Phase 6 reads. */
export type OfferEmailOutcome = 'sent' | 'consent' | 'no_copy' | 'no_recipients' | 'failed';

export interface OfferDelivery {
  /** The in-app inbox notice — the surface the account sees without opening mail. */
  inApp: boolean;
  email: OfferEmailOutcome;
}

/**
 * Deliver one offer over BOTH of the surfaces quota pressure already uses: the
 * org inbox and the email relay. Not a second channel the account has to learn
 * (Phase 3), and not a separate consent either — `offerChannelAllowed` gates both
 * legs, matching the quota notifier, where `enabled: false` silences the inbox
 * notice as well as the mail.
 *
 * Returns both outcomes rather than a boolean: the inbox notice landing while
 * the relay is down is a real and common state, and collapsing the two would
 * make it indistinguishable from an account that heard nothing.
 *
 * Never throws. The decision row is already written by the time this runs, and
 * an exception here would cost the cycle the row it measures from.
 */
export async function deliverOffer(input: {
  rootOrgId: string;
  consent: OfferConsent;
  facts: OfferEmailFacts;
}): Promise<OfferDelivery> {
  if (!offerChannelAllowed(input.consent)) {
    emitCounter('billing_offer_notices_total', { type: input.facts.offerType, outcome: 'consent' });
    emitCounter('billing_offer_emails_total', { type: input.facts.offerType, outcome: 'consent' });
    return { inApp: false, email: 'consent' };
  }
  const text = offerEmailText(input.facts);
  if (!text) {
    // Not an error: the decision stands, it just cannot be stated usefully.
    // Logged because a cycle producing many of these is a catalogue gap, not
    // an account that happened to be quiet. Neither leg goes out — the inbox
    // copy is the same sentence as the mail, so it is no better without a price.
    logger.info('Offer not delivered — no copy names both a limit and a price', {
      orgId: input.rootOrgId, type: input.facts.offerType,
    });
    emitCounter('billing_offer_notices_total', { type: input.facts.offerType, outcome: 'no_copy' });
    emitCounter('billing_offer_emails_total', { type: input.facts.offerType, outcome: 'no_copy' });
    return { inApp: false, email: 'no_copy' };
  }

  // The inbox FIRST, as the quota notifier does: it is the leg that needs no
  // address to resolve, so an account with no reachable admin still sees the
  // offer where it already reads its usage warnings.
  const inApp = await sendSystemNotification({
    recipientOrgId: input.rootOrgId,
    subject: text.subject,
    content: text.text,
    // Never 'high'. An offer is not urgent, and borrowing the priority a
    // breached cap uses is the one thing that would make this feature feel like
    // it was shouting.
    priority: 'normal',
  });
  emitCounter('billing_offer_notices_total', { type: input.facts.offerType, outcome: inApp ? 'sent' : 'failed' });

  const email = await mail(input.rootOrgId, input.facts.offerType, text);
  emitCounter('billing_offer_emails_total', { type: input.facts.offerType, outcome: email });
  return { inApp, email };
}

/**
 * The relay leg. The token is scoped to the ROOT org: the `offerNotice` leg is
 * tenant-bound, so a billing token can only mail the account the offer is about.
 */
async function mail(
  rootOrgId: string,
  offerType: OfferType,
  text: { subject: string; text: string },
): Promise<OfferEmailOutcome> {
  try {
    // api-core's shared path. The endpoint serves five callers; its `offerNotice`
    // leg accepts only the `billing` caller, which is this one.
    const response = await platform().post(NOTIFY_EMAIL_PATH, {
      offerNotice: true,
      orgId: rootOrgId,
      subject: text.subject,
      text: text.text,
    }, {
      headers: { authorization: getServiceAuthHeader({ serviceName: 'billing', orgId: rootOrgId, role: 'member' }) },
      maxRetries: 0,
    });
    // The safe client resolves on 4xx/5xx, so the status is the only signal.
    if (!response || response.statusCode >= 400) {
      logger.warn('Offer email refused by the relay', { orgId: rootOrgId, type: offerType, status: response?.statusCode });
      return 'failed';
    }
    const count = recipientCountOf(response.body);
    // The relay reports zero recipients rather than failing, so an account with
    // no reachable admin is distinguishable from a send that broke.
    return count === 0 ? 'no_recipients' : 'sent';
  } catch (err) {
    logger.warn('Offer email failed', { orgId: rootOrgId, type: offerType, error: errorMessage(err) });
    return 'failed';
  }
}

function recipientCountOf(body: unknown): number | null {
  const data = (body as { data?: { recipientCount?: unknown } } | null)?.data;
  return typeof data?.recipientCount === 'number' ? data.recipientCount : null;
}
