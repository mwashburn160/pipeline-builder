// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, Plan, Subscription, Bundle, ComboDiscount, AddonResult, BillingEvent, BillingInterval, UsageRollup, Discount } from '@/types';

/** Itemized, display-only price breakdown returned by a discount preview/apply.
 *  Concrete mirror of the billing service's `DiscountBreakdown`
 *  (`api/billing/src/helpers/discount-helpers.ts`): a base plan line minus the
 *  usage credit consumed this cycle, with the credit carrying forward. All money
 *  fields are integer cents. */
export interface DiscountPriceBreakdown {
  interval: 'monthly' | 'annual';
  items: { label: string; cents: number }[];
  subtotalCents: number;
  totalCents: number;
  creditRemainingCents: number;
}

/** Authoring input for minting a discount. `code` is the compact authoring form
 *  `value:unit:kind[:campaign]` (e.g. `50:percent:onetime`, `100:dollar:credit`). */
export interface DiscountMintInput {
  code: string;
  targetOrgId?: string;
  alias?: string;
  maxRedemptions?: number;
  redeemBy?: string;
  appliesToTiers?: string[];
  campaign?: string;
}

/** A promotion campaign (rule-driven usage-credit auto-grant). */
export interface PromotionTrigger {
  event: 'subscription_created' | 'plan_change' | 'manual' | 'referral';
  conditions?: { tiers?: string[]; intervals?: Array<'monthly' | 'annual'>; firstSubscriptionOnly?: boolean };
}
export interface Promotion {
  id: string;
  name: string;
  campaign?: string;
  value: number;
  unit: 'dollar' | 'percent';
  kind: 'onetime' | 'recurring';
  referrerValue?: number;
  trigger: PromotionTrigger;
  startsAt?: string;
  endsAt?: string;
  budgetCents: number;
  spentCents: number;
  grantsCount: number;
  perOrgCapCents?: number;
  maxGrants?: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}
export interface PromotionInput {
  name: string;
  campaign?: string;
  value: number;
  unit: 'dollar' | 'percent';
  kind?: 'onetime' | 'recurring';
  referrerValue?: number;
  trigger: PromotionTrigger;
  startsAt?: string;
  endsAt?: string;
  budgetCents: number;
  perOrgCapCents?: number;
  maxGrants?: number;
}
export interface PromotionGrantResult { promotionId: string; granted: boolean; cents?: number; reason?: string }
export interface PromotionSpend {
  budgetCents: number;
  committedCents: number;
  committedGrants: number;
  cachedSpentCents: number;
  cachedGrantsCount: number;
  remainingBudgetCents: number;
  driftCents: number;
}

export function billingApi(core: ApiCore) {
  return {
    // ============================================
    // Billing endpoints (billing service — nginx proxies /api/billing → billing:3000/billing)
    // ============================================

    /** Deployment-config probe: whether the billing service is enabled (and which
     *  provider). Answers in BOTH enabled and disabled mode, so the sidebar can
     *  auto-hide the Billing link when the service is off instead of showing a
     *  link that dead-ends at a 503. */
    getBillingConfig: async () => {
      return core.request<ApiResponse<{ enabled: boolean; provider: string }>>('/api/billing/config');
    },

    /** Get all available plans (public, no auth required). */
    getPlans: async () => {
      return core.request<ApiResponse<{ plans: Plan[]; total: number }>>('/api/billing/plans');
    },

    /** Get current org subscription. */
    getSubscription: async () => {
      return core.request<ApiResponse<{ subscription: Subscription | null }>>('/api/billing/subscriptions');
    },

    /** Create a new subscription. */
    createSubscription: async (planId: string, interval: BillingInterval = 'monthly', referralCode?: string) => {
      return core.request<ApiResponse<{ subscription: Subscription }>>('/api/billing/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ planId, interval, ...(referralCode ? { referralCode } : {}) }),
      });
    },

    /** Change plan or interval on an existing subscription. */
    changeSubscription: async (id: string, data: { planId?: string; interval?: BillingInterval }) => {
      return core.request<ApiResponse<{ subscription: Subscription }>>(`/api/billing/subscriptions/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** Cancel subscription at end of current period. */
    cancelSubscription: async (id: string) => {
      return core.request<ApiResponse<{ subscription: Subscription; message: string }>>(`/api/billing/subscriptions/${id}/cancel`, {
        method: 'POST',
      });
    },

    /** Reactivate a canceled subscription. */
    reactivateSubscription: async (id: string) => {
      return core.request<ApiResponse<{ subscription: Subscription; message: string }>>(`/api/billing/subscriptions/${id}/reactivate`, {
        method: 'POST',
      });
    },

    /** Add-on bundle catalog for the active account, filtered to its tier. */
    getBundles: async () => {
      return core.request<ApiResponse<{ bundles: Bundle[]; selfService: boolean; comboDiscounts?: ComboDiscount[] }>>('/api/billing/bundles');
    },

    /** Dry-run: effective limits + itemized price for a proposed add-on change. */
    previewAddon: async (subscriptionId: string, bundleId: string, quantity: number) => {
      return core.request<ApiResponse<AddonResult>>(`/api/billing/subscriptions/${subscriptionId}/addons/preview`, {
        method: 'POST',
        body: JSON.stringify({ bundleId, quantity }),
      });
    },

    /** Add or set an add-on bundle's quantity. */
    addAddon: async (subscriptionId: string, bundleId: string, quantity: number) => {
      return core.request<ApiResponse<AddonResult>>(`/api/billing/subscriptions/${subscriptionId}/addons`, {
        method: 'POST',
        body: JSON.stringify({ bundleId, quantity }),
      });
    },

    /** Remove an add-on bundle. */
    removeAddon: async (subscriptionId: string, bundleId: string) => {
      return core.request<ApiResponse<AddonResult>>(`/api/billing/subscriptions/${subscriptionId}/addons/${bundleId}`, {
        method: 'DELETE',
      });
    },

    /** Create a hosted billing-portal session and return its URL (add/update a
     *  payment method). Powers the "Add a payment method" CTA after a 402. */
    createBillingPortalSession: async () => {
      return core.request<ApiResponse<{ url: string }>>('/api/billing/portal', { method: 'POST' });
    },

    /** List billing events (admin only) — fleet-wide, optionally filtered by `orgId`. */
    listBillingEvents: async (params?: { orgId?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ events: BillingEvent[]; total: number }>>(`/api/billing/admin/events${buildQuery(params)}`);
    },

    /** The caller's OWN billing events (`billing:read`) — credit applied/consumed/
     *  exhausted, discounts, combos. Scoped to the active org (no `orgId` param). */
    listOwnBillingEvents: async (params?: { limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ events: BillingEvent[]; total: number }>>(`/api/billing/events${buildQuery(params)}`);
    },

    /** F-3.5 cost+usage rollup for the active org. Optional `periodStart`/`periodEnd`
     *  (ISO) reframe the DISPLAYED period window + day math; the usage bars stay the
     *  live current-period snapshot (the quota service tracks only the current period). */
    getBillingUsage: async (params?: { periodStart?: string; periodEnd?: string }) => {
      return core.request<ApiResponse<UsageRollup>>(`/api/billing/usage${buildQuery(params)}`);
    },

    /** Dashboard summary — account totals (gross → discounts/credits → net) + per-period timeline. */
    getBillingSummary: async (params?: { from?: string; to?: string }) => {
      return core.request<ApiResponse<BillingSummary>>(`/api/billing/summary${buildQuery(params)}`);
    },

    /** Paginated invoice rows for the dashboard table. */
    listBillingInvoices: async (params?: { from?: string; to?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ invoices: BillingInvoiceRow[]; pagination: { total: number; limit: number; offset: number } }>>(`/api/billing/invoices${buildQuery(params)}`);
    },

    /** Cost-by-team showback — apportion the account's billed actuals across its subtree. */
    getBillingAllocation: async (params?: { from?: string; to?: string; driver?: string; includeDescendants?: boolean }) => {
      return core.request<ApiResponse<BillingAllocation>>(`/api/billing/summary/allocation${buildQuery(params)}`);
    },

    /** Per-team current usage across all quota dimensions (feature-gated: team_usage_analytics). */
    getTeamUsage: async (params?: { includeDescendants?: boolean }) => {
      return core.request<ApiResponse<{ teams: TeamUsageRow[] }>>(`/api/billing/summary/usage-by-team${buildQuery(params)}`);
    },

    // ============================================
    // Discounts — self-service redemption (docs/billing-discounts.md)
    // ============================================

    /** Dry-run a discount code against the active subscription (billing:read). */
    previewDiscountCode: async (subscriptionId: string, code: string) => {
      return core.request<ApiResponse<{ applied: string; priceBreakdown: DiscountPriceBreakdown }>>(`/api/billing/subscriptions/${subscriptionId}/discounts/preview`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
    },

    /** Redeem a discount code (token or public alias) onto the subscription (billing:manage). */
    redeemDiscountCode: async (subscriptionId: string, code: string) => {
      return core.request<ApiResponse<{ discount: Discount; applied: string; priceBreakdown: DiscountPriceBreakdown }>>(`/api/billing/subscriptions/${subscriptionId}/discounts`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
    },

    /** Stop a standing recurring discount (already-granted credit persists) (billing:manage). */
    removeSubscriptionDiscount: async (subscriptionId: string, discountId: string) => {
      return core.request<ApiResponse<{ discountId: string }>>(`/api/billing/subscriptions/${subscriptionId}/discounts/${discountId}`, {
        method: 'DELETE',
      });
    },

    // ============================================
    // Discounts — admin authoring (system-admin only)
    // ============================================

    /** List discount records (filtered + paginated). Never returns a token. */
    listDiscounts: async (params?: { campaign?: string; targetOrgId?: string; active?: 'true' | 'false'; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ discounts: Discount[]; pagination: { total: number; limit: number; offset: number } }>>(`/api/billing/admin/discounts${buildQuery(params)}`);
    },

    /** Mint a discount record from the authoring form. */
    createDiscount: async (body: DiscountMintInput) => {
      return core.request<ApiResponse<{ discount: Discount }>>('/api/billing/admin/discounts', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    /** Issue (mint/re-issue) an opaque redeemable token for a discount. */
    issueDiscountToken: async (id: string) => {
      return core.request<ApiResponse<{ token: string }>>(`/api/billing/admin/discounts/${id}/token`, { method: 'POST' });
    },

    /** Direct-grant a discount to a target org (Mode A). */
    applyDiscountToOrg: async (id: string, targetOrgId: string) => {
      return core.request<ApiResponse<{ discount: Discount; applied: string; priceBreakdown: DiscountPriceBreakdown }>>(`/api/billing/admin/discounts/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ targetOrgId }),
      });
    },

    /** Dry-run a direct grant on a target org. */
    previewDiscountForOrg: async (id: string, targetOrgId: string) => {
      return core.request<ApiResponse<{ applied: string; priceBreakdown: DiscountPriceBreakdown }>>(`/api/billing/admin/discounts/${id}/preview`, {
        method: 'POST',
        body: JSON.stringify({ targetOrgId }),
      });
    },

    /** Edit / revoke (isActive:false) a discount. */
    updateDiscount: async (id: string, body: { isActive?: boolean; maxRedemptions?: number; redeemBy?: string; appliesToTiers?: string[] }) => {
      return core.request<ApiResponse<{ discount: Discount }>>(`/api/billing/admin/discounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    /** Hard-revoke a discount (isActive:false). */
    deleteDiscount: async (id: string) => {
      return core.request<ApiResponse<{ discount: Discount }>>(`/api/billing/admin/discounts/${id}`, { method: 'DELETE' });
    },

    // ============================================
    // Promotions — admin authoring (system-admin only)
    // ============================================

    /** List promotion campaigns. */
    listPromotions: async (params?: { campaign?: string; active?: 'true' | 'false' }) => {
      return core.request<ApiResponse<{ promotions: Promotion[]; total: number }>>(`/api/billing/admin/promotions${buildQuery(params)}`);
    },

    /** Mint a promotion campaign. */
    createPromotion: async (body: PromotionInput) => {
      return core.request<ApiResponse<{ promotion: Promotion }>>('/api/billing/admin/promotions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    /** Edit / activate / revoke a promotion. */
    updatePromotion: async (id: string, body: Partial<{ name: string; isActive: boolean; endsAt: string; budgetCents: number; maxGrants: number }>) => {
      return core.request<ApiResponse<{ promotion: Promotion }>>(`/api/billing/admin/promotions/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    /** Manually grant a promotion to one org (honors budget + idempotency). */
    grantPromotion: async (id: string, targetOrgId: string) => {
      return core.request<ApiResponse<{ result: PromotionGrantResult }>>(`/api/billing/admin/promotions/${id}/grant`, {
        method: 'POST',
        body: JSON.stringify({ targetOrgId }),
      });
    },

    /** Grant across the existing eligible base now (batch activation). */
    activatePromotion: async (id: string) => {
      return core.request<ApiResponse<{ result: { total: number; matched: number; granted: number; alreadyGranted: number; skippedBudget: number; spentCents: number } }>>(`/api/billing/admin/promotions/${id}/activate`, { method: 'POST' });
    },

    /** Projected reach + committed spend for a campaign. */
    previewPromotion: async (id: string) => {
      return core.request<ApiResponse<{ projection: { eligibleOrgs: number; projectedCents: number; remainingBudgetCents: number } }>>(`/api/billing/admin/promotions/${id}/preview`, { method: 'POST' });
    },

    /** Ledger-derived spend rollup (authoritative + advisory cache + drift). */
    promotionSpend: async (id: string) => {
      return core.request<ApiResponse<{ spend: PromotionSpend }>>(`/api/billing/admin/promotions/${id}/spend`);
    },

    // ============================================
    // Admin — subscriptions & platform finance (system-admin only)
    // ============================================

    /** List every org's subscription (paginated). Optional `status` filter. */
    listAdminSubscriptions: async (params?: { status?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ subscriptions: Subscription[]; total: number; limit: number; offset: number }>>(`/api/billing/admin/subscriptions${buildQuery(params)}`);
    },

    /** Admin override on one subscription — plan / status / interval / cancel flag. */
    updateAdminSubscription: async (id: string, body: AdminSubscriptionUpdate) => {
      return core.request<ApiResponse<{ subscription: Subscription }>>(`/api/billing/admin/subscriptions/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    /** Cross-account finance aggregate (totals + per-org impact). `orgId` narrows to one account. */
    getAdminBillingSummary: async (params?: { from?: string; to?: string; orgId?: string }) => {
      return core.request<ApiResponse<AdminBillingSummary>>(`/api/billing/admin/summary${buildQuery(params)}`);
    },

    /** One-off: seed the ledger from the provider's historical invoices (idempotent). */
    runBillingBackfill: async () => {
      return core.request<ApiResponse<LedgerBackfillResult>>('/api/billing/admin/backfill', { method: 'POST' });
    },

    /** Purge every subscription + billing event for an org (cascade hook; destructive). */
    deleteSubscriptionByOrg: async (orgId: string) => {
      return core.request<ApiResponse<{ deleted: number; events: number }>>(`/api/billing/subscriptions/by-org/${orgId}`, { method: 'DELETE' });
    },

    // ============================================
    // AWS Marketplace entitlements (billing:read)
    // ============================================

    /** Current AWS Marketplace entitlements for the active org. 400 when the active
     *  provider isn't aws-marketplace; 404 when the org has no marketplace sub. */
    getMarketplaceEntitlements: async () => {
      return core.request<ApiResponse<MarketplaceEntitlements>>('/api/billing/marketplace/entitlements');
    },
  };
}

/** Admin override body for PUT /billing/admin/subscriptions/:id (AdminSubscriptionUpdateSchema). */
export interface AdminSubscriptionUpdate {
  planId?: string;
  status?: 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';
  interval?: BillingInterval;
  cancelAtPeriodEnd?: boolean;
}

/** Cross-account finance aggregate (GET /billing/admin/summary). */
export interface AdminBillingSummary {
  totals: { grossBilledCents: number; discountsCents: number; creditsCents: number; taxCents: number; netBilledCents: number; amountPaidCents: number };
  byOrg: Array<{ orgId: string; grossBilledCents: number; creditsCents: number; discountsCents: number; netBilledCents: number; invoiceCount: number }>;
  invoiceCount: number;
}

/** Counts returned by POST /billing/admin/backfill. */
export interface LedgerBackfillResult {
  accounts: number;
  ingested: number;
  errors: number;
}

/** One AWS Marketplace entitlement dimension. `expirationDate` is an ISO string over the wire. */
export interface MarketplaceEntitlement {
  planId: string;
  dimension: string;
  isEntitled: boolean;
  expirationDate?: string;
}

/** GET /billing/marketplace/entitlements response. */
export interface MarketplaceEntitlements {
  customerIdentifier: string;
  entitlements: MarketplaceEntitlement[];
  currentPlanId: string;
}

export interface TeamUsageRow {
  orgId: string;
  name?: string;
  seats: number | null;
  usage: Record<string, number | null>;
}

export interface BillingSummary {
  scope: string;
  totals: { grossBilledCents: number; discountsCents: number; creditsCents: number; taxCents: number; netBilledCents: number; amountPaidCents: number };
  timeline: Array<{ periodStart: string; grossCents: number; discountCents: number; creditCents: number; netCents: number }>;
  invoiceCount: number;
}

export interface BillingInvoiceRow {
  periodStart: string; periodEnd: string;
  grossCents: number; discountCents: number; creditCents: number; taxCents: number; netCents: number; amountPaidCents: number;
  status: 'paid' | 'open' | 'void' | 'uncollectible';
}

export interface BillingAllocation {
  driver: string;
  totals: { grossBilledCents: number; discountsCents: number; creditsCents: number; taxCents: number; netBilledCents: number };
  rows: Array<{ orgId: string; driverUnits: number; sharePct: number; grossCents: number; discountCents: number; creditCents: number; taxCents: number; netCents: number }>;
  unallocated: { grossBilledCents: number; discountsCents: number; creditsCents: number; taxCents: number; netBilledCents: number };
}
