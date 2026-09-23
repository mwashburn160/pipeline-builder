// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The frontend's shared domain types, one module per domain. This barrel is the
 * import path every call site uses (`@/types`); the domain modules exist so the
 * types are findable and reviewable, not as a second public path.
 *
 * Narrower type modules that are NOT part of this barrel (`@/types/compliance`,
 * `@/types/ecosystem`, `@/types/observability`, …) belong to one feature area
 * and are imported directly.
 */

// Wire vocabularies come from the api-core source of truth, so the frontend
// unions can't drift from the backend's. `import type` / `export type` is fully
// erased at build time, so this pulls no server-only runtime code into the
// Next bundle.
export type {
  BillingInterval, Criticality, EntityLink, IdpProtocol, IdpProvider, Lifecycle, MessagePriority,
  MessageType, OwnerType, QuotaTier, QuotaType, RoleGrant, SamlAttributeMapping, SubscriptionStatus,
  TemplateInput, Visibility,
} from '@pipeline-builder/api-core';

export * from './api';
export * from './billing';
export * from './identity';
export * from './message';
export * from './organization';
export * from './pipeline';
export * from './plugin';
export * from './registry';
export * from './sso';
