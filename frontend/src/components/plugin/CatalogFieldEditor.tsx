// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react';
import { Check, Pencil, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { CATEGORY_DISPLAY_NAMES, PLUGIN_CATEGORIES } from '@/lib/plugin-categories';
import {
  CATALOG_FIELD_EDITOR, CATALOG_FIELD_HINTS, CATALOG_FIELD_LABELS, CATALOG_SOURCE_LABELS,
  catalogValueToText, parseCatalogText,
} from '@/lib/plugin-catalog';
import type { PluginCatalogEdits, PluginCatalogField, PluginIcon, PluginMetadataSource } from '@/types';

/** One detected catalog field: its value, where it came from, and why it was refused. */
export interface CatalogEditorField {
  field: PluginCatalogField;
  /** string | string[] (keywords) | {key, badge?} (icon) | null. */
  value: unknown;
  source: PluginMetadataSource | null;
  /** Why the detected value was refused (then `value` is null). */
  error?: string | null;
}

/** How a value reads in the review list. */
export function catalogDisplayValue(field: PluginCatalogField, value: unknown): string {
  if (field === 'category' && typeof value === 'string') {
    return CATEGORY_DISPLAY_NAMES[value as keyof typeof CATEGORY_DISPLAY_NAMES] ?? value;
  }
  if (field === 'icon' && value && typeof value === 'object') {
    const icon = value as PluginIcon;
    return icon.badge ? `${icon.key} (badge: ${icon.badge})` : icon.key;
  }
  return catalogValueToText(field, value);
}

const LONG_FIELDS: ReadonlySet<PluginCatalogField> = new Set(['description', 'changelog', 'readme']);

interface CatalogFieldEditorProps {
  /** The detected fields; `null` while they are still being read (no list, no Accept all). */
  fields: readonly CatalogEditorField[] | null;
  /** The fields the user edited — ONLY those; `null` clears a field. */
  edits: PluginCatalogEdits;
  onEditsChange: (edits: PluginCatalogEdits) => void;
  disabled?: boolean;
  heading: string;
  headingId: string;
  description: ReactNode;
  /** Rendered between the header and the field list (progress, errors, a caption). */
  children?: ReactNode;
  testId?: string;
  /** Server-side refusals per field (e.g. a 400 on submit), shown under the field. */
  fieldErrors?: Partial<Record<PluginCatalogField, string>>;
}

/**
 * The accept-or-edit field list (plugin-ecosystem §3.1a, D19): every descriptive
 * catalog field with its detected value and a source badge (Spec / README /
 * Dockerfile / Generated / Edited), and **Accept** or **Edit** per field plus
 * **Accept all**. Only EDITED fields are reported through `onEditsChange` —
 * everything else is accepted as detected. Shared by the upload dialog's
 * Catalog details step and the publish-request form.
 */
export function CatalogFieldEditor({
  fields, edits, onEditsChange, disabled = false, heading, headingId, description, children, testId, fieldErrors,
}: CatalogFieldEditorProps) {
  const [accepted, setAccepted] = useState<ReadonlySet<PluginCatalogField>>(new Set());
  const [editing, setEditing] = useState<PluginCatalogField | null>(null);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);

  const isEdited = (field: PluginCatalogField) => Object.prototype.hasOwnProperty.call(edits, field);

  const accept = (field: PluginCatalogField) => setAccepted((prev) => new Set(prev).add(field));

  const acceptAll = () => {
    if (!fields) return;
    setAccepted(new Set(fields.map((f) => f.field).filter((f) => !isEdited(f))));
    setEditing(null);
  };

  const startEdit = (f: CatalogEditorField) => {
    setEditing(f.field);
    setDraft(catalogValueToText(f.field, isEdited(f.field) ? edits[f.field] : f.value));
    setDraftError(null);
  };

  const saveEdit = (f: CatalogEditorField) => {
    const prevIcon = f.field === 'icon' && f.value && typeof f.value === 'object' ? f.value as PluginIcon : null;
    const parsed = parseCatalogText(f.field, draft, prevIcon);
    if (!parsed.ok) { setDraftError(parsed.error); return; }
    const next = { ...edits };
    // Re-entering the detected value is not an edit.
    const unchanged = JSON.stringify(parsed.value ?? null) === JSON.stringify(f.value ?? null)
      || (parsed.value === null && f.value == null);
    if (unchanged) delete next[f.field];
    else (next as Record<string, unknown>)[f.field] = parsed.value;
    onEditsChange(next);
    setAccepted((prev) => { const s = new Set(prev); s.delete(f.field); return s; });
    setEditing(null);
  };

  const revert = (field: PluginCatalogField) => {
    const next = { ...edits };
    delete next[field];
    onEditsChange(next);
    if (editing === field) setEditing(null);
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={headingId} className="text-sm font-semibold text-fg">{heading}</h3>
          <p className="text-xs text-fg-muted">{description}</p>
        </div>
        {fields && (
          <Button variant="secondary" size="sm" onClick={acceptAll} disabled={disabled}>
            <Check className="w-4 h-4 mr-1" aria-hidden />Accept all
          </Button>
        )}
      </div>

      {children}

      {fields && (
        <ul className="divide-y divide-default rounded-lg border border-default">
          {fields.map((f) => {
            const label = CATALOG_FIELD_LABELS[f.field] ?? f.field;
            const edited = isEdited(f.field);
            const shown = edited ? edits[f.field] : f.value;
            const text = catalogDisplayValue(f.field, shown);
            const isEditing = editing === f.field;
            return (
              <li key={f.field} className="p-3 space-y-1.5" data-testid={`catalog-field-${f.field}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-fg">{label}</span>
                    {edited ? (
                      <Badge color="purple">Edited</Badge>
                    ) : f.source ? (
                      <Badge color={f.source === 'user' ? 'purple' : 'gray'}>{CATALOG_SOURCE_LABELS[f.source]}</Badge>
                    ) : null}
                    {!edited && accepted.has(f.field) && <Badge color="green">Accepted</Badge>}
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      {edited ? (
                        <Button variant="ghost" size="xs" onClick={() => revert(f.field)} disabled={disabled} aria-label={`Revert ${label}`}>
                          <RotateCcw className="w-3.5 h-3.5 mr-1" aria-hidden />Revert
                        </Button>
                      ) : (
                        <Button
                          variant="ghost" size="xs" onClick={() => accept(f.field)}
                          disabled={disabled || accepted.has(f.field)} aria-label={`Accept ${label}`}
                        >
                          <Check className="w-3.5 h-3.5 mr-1" aria-hidden />Accept
                        </Button>
                      )}
                      <Button variant="ghost" size="xs" onClick={() => startEdit(f)} disabled={disabled} aria-label={`Edit ${label}`}>
                        <Pencil className="w-3.5 h-3.5 mr-1" aria-hidden />Edit
                      </Button>
                    </div>
                  )}
                </div>

                {!isEditing && (
                  text ? (
                    LONG_FIELDS.has(f.field) ? (
                      <pre className="text-xs text-fg-muted whitespace-pre-wrap break-words max-h-24 overflow-y-auto font-sans">{text}</pre>
                    ) : (
                      <p className="text-sm text-fg-muted break-words">{text}</p>
                    )
                  ) : edited ? (
                    <p className="text-sm italic text-fg-subtle">Cleared</p>
                  ) : f.error ? (
                    <p className="text-xs text-danger-strong" role="note">Not used: {f.error}</p>
                  ) : (
                    <p className="text-sm italic text-fg-subtle">Not found in package</p>
                  )
                )}

                {!isEditing && fieldErrors?.[f.field] && (
                  <p className="text-xs text-danger-strong" role="alert" data-testid={`catalog-field-error-${f.field}`}>
                    {fieldErrors[f.field]}
                  </p>
                )}

                {isEditing && (
                  <div className="space-y-2">
                    <FormField label={`New ${label.toLowerCase()}`} error={draftError ?? undefined} hint={CATALOG_FIELD_HINTS[f.field]}>
                      {CATALOG_FIELD_EDITOR[f.field] === 'textarea' ? (
                        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={f.field === 'description' ? 3 : 6} disabled={disabled} />
                      ) : CATALOG_FIELD_EDITOR[f.field] === 'select' ? (
                        <Select value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled}>
                          <option value="">— None —</option>
                          {PLUGIN_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_DISPLAY_NAMES[c]}</option>)}
                        </Select>
                      ) : (
                        <Input
                          type="text" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled}
                          placeholder={CATALOG_FIELD_EDITOR[f.field] === 'keywords' ? 'keyword1, keyword2' : undefined}
                        />
                      )}
                    </FormField>
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" size="xs" onClick={() => setEditing(null)}>Cancel</Button>
                      <Button size="xs" onClick={() => saveEdit(f)} disabled={disabled}>Save</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
