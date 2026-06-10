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

/**
 * Reset the cached aliases.
 *
 * WARNING: TEST-ONLY. This is exported solely so unit tests can clear the
 * module-level cache between cases when they mutate alias env vars. Do NOT
 * call from production code paths — mutating the cache at runtime is
 * unsupported and will cause inconsistent alias resolution under concurrency.
 *
 * @internal
 */
export function _resetAliasCache(): void {
  _supportAliases = undefined;
}
