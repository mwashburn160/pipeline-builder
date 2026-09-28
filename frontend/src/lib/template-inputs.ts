// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inputs editor's row model, shared by the create and edit template modals.
 *
 * Both modals edit the same thing — a template's declared `inputs` — and both had their own
 * copy of this: the row interface, the name rule, and the row↔API conversions. The two
 * conversion bodies were byte-identical after normalisation, which is how they were found.
 *
 * The one that mattered is `INPUT_NAME_RE`. A VALIDATION rule in two files is a rule that
 * drifts: tighten it in the create modal and the edit modal keeps accepting what the create
 * modal now rejects, so a template you cannot create can still be saved. The two
 * conversions drifting would be milder but the same shape — an input that round-trips
 * through edit differently from how create wrote it.
 */

import type { TemplateInput } from '@/types';

/** A row in the inputs editor — the editable counterpart of a {@link TemplateInput}. */
export interface EditableInput {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  default: string;
  /** Comma-separated in the editor; a string[] on the API. */
  options: string;
}

/**
 * A legal input name.
 *
 * Identifier-shaped because the name becomes a `{{ vars.<name> }}` reference in the saved
 * props — anything else produces a substitution that silently resolves to nothing.
 */
export const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Seed editor rows from a template's declared inputs. */
export function toEditableInputs(inputs: TemplateInput[] | undefined): EditableInput[] {
  return (inputs || []).map((inp) => ({
    name: inp.name,
    label: inp.label ?? '',
    type: inp.type,
    required: Boolean(inp.required),
    default: inp.default !== undefined ? String(inp.default) : '',
    options: (inp.options ?? []).join(', '),
  }));
}

/**
 * Build the API `inputs` from the editable rows.
 *
 * Drops nameless rows, splits `options` on commas, and coerces `default` to the row's
 * declared type — a `number` input whose default stayed a string would be written back as
 * `"3"` and then fail its own type on the next read.
 */
export function toTemplateInputs(rows: EditableInput[]): TemplateInput[] {
  return rows
    .filter((r) => r.name.trim())
    .map((r) => {
      const opts = r.options.split(',').map((o) => o.trim()).filter(Boolean);
      const inp: TemplateInput = { name: r.name.trim(), type: r.type };
      if (r.label.trim()) (inp as { label?: string }).label = r.label.trim();
      if (r.required) (inp as { required?: boolean }).required = true;
      if (opts.length) (inp as { options?: string[] }).options = opts;
      if (r.default.trim()) {
        const d = r.type === 'number' ? Number(r.default) : r.type === 'boolean' ? r.default === 'true' : r.default;
        (inp as { default?: unknown }).default = d;
      }
      return inp;
    });
}
