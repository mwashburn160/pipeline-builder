// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import { validateSource, previewResolve, type Token, type Position } from '@/lib/templates';

export interface UseTemplateValidationResult {
  /** True when the string is either plain text or a valid template */
  valid: boolean;
  /** Parsed token stream, or empty array on parse error */
  tokens: Token[];
  /** Whether the source actually contains `{{ ... }}` template tokens */
  hasTemplate: boolean;
  /** Parse error message (when not valid) */
  error?: string;
  /** Parse error source position (when not valid) */
  errorPos?: Position;
  /** Resolved preview when `scope` is provided and resolution succeeds */
  resolved?: unknown;
  /** Resolution error (distinct from parse error) when scope provided */
  resolveError?: string;
}

/**
 * Hook: validate a user-entered string that may contain `{{ ... }}` tokens.
 * Returns parse-time diagnostics; when `scope` is provided, also returns the
 * resolved preview value for live feedback in editors.
 *
 * Zero-alloc fast path for plain strings (no `{{` substring) — skips parsing.
 */
export function useTemplateValidation(
  source: string | undefined,
  scope?: Record<string, unknown>,
): UseTemplateValidationResult {
  return useMemo(() => {
    const src = source ?? '';
    const v = validateSource(src);
    const result: UseTemplateValidationResult = {
      valid: v.valid,
      tokens: v.tokens,
      hasTemplate: src.includes('{{'),
      error: v.error,
      errorPos: v.errorPos,
    };
    if (!scope || !result.valid || !result.hasTemplate) return result;

    const preview = previewResolve(src, scope);
    if (preview.ok) result.resolved = preview.value;
    else result.resolveError = preview.error;
    return result;
  }, [source, scope]);
}
