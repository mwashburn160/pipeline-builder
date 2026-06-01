// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Named OAuth provider identifiers shared across the platform.
 *
 * Centralised here so models (invitations, IdP configs, …) and any future
 * provider-aware code reference one source of truth instead of redeclaring
 * the union locally. `generic-oidc` is intentionally NOT in this union —
 * it's specific to the IdP-config flow (any OIDC-compliant issuer); the
 * named providers below have wired-up OAuth handlers in `controllers/oauth.ts`.
 */
export type OAuthProviderName = 'google' | 'github';

/** Runtime tuple matching `OAuthProviderName` for Mongoose enums / Zod schemas. */
export const OAUTH_PROVIDER_NAMES: readonly OAuthProviderName[] = ['google', 'github'];
