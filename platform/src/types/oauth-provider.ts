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
export type OAuthProviderName = 'google' | 'github' | 'facebook' | 'microsoft' | 'gitlab' | 'linkedin';

/** Runtime tuple matching `OAuthProviderName` for Mongoose enums / Zod schemas. */
export const OAUTH_PROVIDER_NAMES: readonly OAuthProviderName[] = ['google', 'github', 'facebook', 'microsoft', 'gitlab', 'linkedin'];

/**
 * Whether `value` names one of the wired providers, narrowing it as it goes.
 *
 * The point is to delete casts, not to add a check. Every caller that had a
 * provider name as a `string` reached its registry through one — `providers[name
 * as OAuthProviderName]`, or in one place `config.oauth as unknown as
 * Record<string, …>` — and a cast is exactly as wrong as the name is: a typo or
 * a renamed provider compiles and resolves to `undefined` at runtime. Narrowing
 * from this list instead means the compiler checks the lookup, and a name that
 * is not a provider is handled rather than assumed away.
 */
export function isOAuthProviderName(value: string): value is OAuthProviderName {
  return (OAUTH_PROVIDER_NAMES as readonly string[]).includes(value);
}
