// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useTemplateValidation } from '@/hooks/useTemplateValidation';
import type { MetadataEntry } from '@/types/form-types';

/**
 * Keep a typed entry's value legal for its type.
 *
 * `MetadataEntry.value` is always a string, so switching an entry to `boolean`
 * can leave arbitrary text behind where the UI then renders a `<select>` of
 * true/false — which shows a blank selection and silently submits whatever the
 * old text was. MetadataEditor and VarsEditor both carried this coercion
 * inline; it is an invariant of the shape, not of either editor, so it lives
 * with the shape.
 */
export function coerceEntryValue(entry: MetadataEntry): MetadataEntry {
  if (entry.type === 'boolean' && entry.value !== 'true' && entry.value !== 'false') {
    return { ...entry, value: 'false' };
  }
  return entry;
}

/**
 * Border class + validation state for a value input that may hold `{{ … }}`.
 *
 * Only string values are parsed: a number or boolean entry has no template to
 * find, and running the parser over it would light the "contains a template"
 * affordance on text that cannot contain one.
 */
export function useTemplateValueStyle(entry: MetadataEntry): {
  validation: ReturnType<typeof useTemplateValidation>;
  invalid: boolean;
  border: string;
} {
  const validation = useTemplateValidation(entry.type === 'string' ? entry.value : undefined);
  const invalid = validation.hasTemplate && !validation.valid;
  const border = invalid
    ? 'border-danger-border'
    : validation.hasTemplate
      ? 'border-indigo-400 dark:border-indigo-500'
      : 'border-default';
  return { validation, invalid, border };
}

/**
 * The line under a templated value input — the parse error, or a count of the
 * tokens that will be resolved at synth time.
 *
 * Shared so the two editors cannot drift on the wording. "Resolved at synth
 * time" is the load-bearing half: it tells the author the braces are not
 * literal text, which is the single most common misreading of this field.
 */
export function TemplateValueHint({
  validation,
  invalid,
}: {
  validation: ReturnType<typeof useTemplateValueStyle>['validation'];
  invalid: boolean;
}): React.ReactElement | null {
  if (invalid) {
    return <div className="mt-0.5 text-xs text-danger" role="alert">{validation.error}</div>;
  }
  if (!validation.hasTemplate || !validation.valid) return null;
  const count = validation.tokens.filter((t) => t.kind === 'expr').length;
  return (
    <div className="mt-0.5 text-xs text-indigo-600 dark:text-indigo-400">
      Contains {count} template token{count === 1 ? '' : 's'} — resolved at synth time
    </div>
  );
}
