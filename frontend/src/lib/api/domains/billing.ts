// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, Plan, Subscription, Bundle, ComboDiscount, AddonResult, BillingEvent, BillingInterval, UsageRollup } from '@/types';

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
    createSubscription: async (planId: string, interval: BillingInterval = 'monthly') => {
      return core.request<ApiResponse<{ subscription: Subscription }>>('/api/billing/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ planId, interval }),
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

    /** F-3.5 cost+usage rollup for the active org. */
    getBillingUsage: async () => {
      return core.request<ApiResponse<UsageRollup>>('/api/billing/usage');
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
  };
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
