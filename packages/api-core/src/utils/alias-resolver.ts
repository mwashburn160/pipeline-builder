// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_ORG_ID } from '../middleware/auth.js';

/** Lazily-cached set of support aliases, parsed from SUPPORT_ALIASES on first access. */
let _supportAliases: Set<string> | undefined;

function getSupportAliases(): Set<string> {
  if (!_supportAliases) {
    const raw = process.env.SUPPORT_ALIASES || '';
    _supportAliases = new Set(
      raw
        .split(',')
        .map(alias => alias.trim().toLowerCase())
        .filter(alias => alias.length > 0),
    );
  }
  return _supportAliases;
}

/** Well-known fallback support alias used when SUPPORT_ALIASES is unconfigured. */
export const DEFAULT_SUPPORT_ALIAS = 'support@pipeline-builder';

/**
 * The PRIMARY (first-configured) support alias — for display / prefill in UIs
 * (e.g. the compose "To" field), so the shown value is driven by SUPPORT_ALIASES
 * rather than hardcoded. Falls back to {@link DEFAULT_SUPPORT_ALIAS} when the env
 * is unset. (All configured aliases still resolve via {@link resolveRecipientAlias}.)
 */
export function getPrimarySupportAlias(): string {
  for (const alias of getSupportAliases()) return alias;
  return DEFAULT_SUPPORT_ALIAS;
}

/** Result of alias resolution. */
export interface AliasResolution {
  /** The resolved organization ID (e.g., 'system'). */
  resolvedOrgId: string;
  /** Whether the input was an alias that got resolved. */
  wasAlias: boolean;
  /** The original input value, useful for audit logging. */
  originalValue: string;
}

/**
 * Resolve an email-like alias to an actual organization ID.
 *
 * If the input matches a configured support alias, it resolves to the system
 * org ID. Otherwise the input is returned as-is (lowercased).
 */
export function resolveRecipientAlias(recipientOrgId: string): AliasResolution {
  const normalized = recipientOrgId.trim().toLowerCase();
  const aliases = getSupportAliases();

  if (aliases.has(normalized)) {
    return {
      resolvedOrgId: SYSTEM_ORG_ID,
      wasAlias: true,
      originalValue: recipientOrgId,
    };
  }

  return {
    resolvedOrgId: normalized,
    wasAlias: false,
    originalValue: recipientOrgId,
  };
}

