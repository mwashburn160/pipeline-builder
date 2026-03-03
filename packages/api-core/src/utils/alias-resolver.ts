/**
 * @module utils/alias-resolver
 * @description Resolves email-like aliases to actual organization IDs.
 *
 * Configured via environment variables:
 * - SUPPORT_ALIASES: Comma-separated list of email aliases that resolve to the system org
 *   Example: "support@pipeline-builder,help@pipeline-builder"
 */

import { SYSTEM_ORG_ID } from '../middleware/auth';

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

/** Check if a given string is a configured support alias. */
export function isSupportAlias(value: string): boolean {
  return getSupportAliases().has(value.trim().toLowerCase());
}

/**
 * Reset the cached aliases (for testing purposes only).
 * @internal
 */
export function _resetAliasCache(): void {
  _supportAliases = undefined;
}
