// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, Plan, Subscription, Bundle, AddonResult, BillingEvent, BillingInterval, UsageRollup } from '@/types';

export function billingApi(core: ApiCore) {
  return {
    // ============================================
    // Billing endpoints (billing service — nginx proxies /api/billing → billing:3000/billing)
    // ============================================

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
      return core.request<ApiResponse<{ bundles: Bundle[]; selfService: boolean }>>('/api/billing/bundles');
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

    /** List billing events (admin only). */
    listBillingEvents: async (params?: { orgId?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ events: BillingEvent[]; total: number }>>(`/api/billing/admin/events${buildQuery(params)}`);
    },

    /** F-3.5 cost+usage rollup for the active org. */
    getBillingUsage: async () => {
      return core.request<ApiResponse<UsageRollup>>('/api/billing/usage');
    },
  };
}
