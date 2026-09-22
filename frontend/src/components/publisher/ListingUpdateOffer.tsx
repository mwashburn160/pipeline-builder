// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Check, Pencil, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { catalogDisplayValue } from '@/components/plugin/CatalogFieldEditor';
import { CATEGORY_DISPLAY_NAMES, PLUGIN_CATEGORIES } from '@/lib/plugin-categories';
import {
  CATALOG_FIELD_EDITOR, CATALOG_FIELD_HINTS, CATALOG_FIELD_LABELS, catalogValueToText, parseCatalogText,
} from '@/lib/plugin-catalog';
import type { PluginCatalogEdits, PluginCatalogField, PluginIcon } from '@/types';
import type { ListingUpdateOfferField } from '@/types/ecosystem';

interface Props {
  offer: readonly ListingUpdateOfferField[];
  /** The fields chosen to change on the listing — accepted or edited. Everything
   *  else keeps the listing's current value. */
  edits: PluginCatalogEdits;
  onEditsChange: (edits: PluginCatalogEdits) => void;
  disabled?: boolean;
}

/**
 * The changed-fields-only `listing_update` offer for a new version: each
 * field whose detected value differs from the live listing, with
 * **Accept** (take the new value), **Keep current** (the default — nothing flows
 * to the listing silently) or **Edit**.
 */
export function ListingUpdateOffer({ offer, edits, onEditsChange, disabled = false }: Props) {
  const [editing, setEditing] = useState<PluginCatalogField | null>(null);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);

  const chosen = (field: PluginCatalogField) => Object.prototype.hasOwnProperty.call(edits, field);

  const set = (field: PluginCatalogField, value: unknown) => {
    onEditsChange({ ...edits, [field]: value } as PluginCatalogEdits);
  };
  const keep = (field: PluginCatalogField) => {
    const next = { ...edits };
    delete next[field];
    onEditsChange(next);
    if (editing === field) setEditing(null);
  };

  const startEdit = (f: ListingUpdateOfferField) => {
    setEditing(f.field);
    setDraft(catalogValueToText(f.field, chosen(f.field) ? edits[f.field] : f.value));
    setDraftError(null);
  };

  const saveEdit = (f: ListingUpdateOfferField) => {
    const prevIcon = f.field === 'icon' && f.current && typeof f.current === 'object' ? f.current as PluginIcon : null;
    const parsed = parseCatalogText(f.field, draft, prevIcon);
    if (!parsed.ok) { setDraftError(parsed.error); return; }
    set(f.field, parsed.value);
    setEditing(null);
  };

  return (
    <ul className="divide-y divide-default rounded-lg border border-default" aria-label="Changed listing fields">
      {offer.map((f) => {
        const label = CATALOG_FIELD_LABELS[f.field] ?? f.field;
        const isChosen = chosen(f.field);
        const accepted = isChosen && JSON.stringify(edits[f.field] ?? null) === JSON.stringify(f.value ?? null);
        return (
          <li key={f.field} className="p-3 space-y-2" data-testid={`offer-field-${f.field}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-fg">{label}</span>
                {!isChosen ? <Badge color="gray">Unchanged</Badge> : accepted ? <Badge color="green">Accepted</Badge> : <Badge color="purple">Edited</Badge>}
              </div>
              {editing !== f.field && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="xs" onClick={() => set(f.field, f.value)} disabled={disabled || accepted} aria-label={`Accept new ${label}`}>
                    <Check className="w-3.5 h-3.5 mr-1" aria-hidden />Accept
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => keep(f.field)} disabled={disabled || !isChosen} aria-label={`Keep current ${label}`}>
                    <Undo2 className="w-3.5 h-3.5 mr-1" aria-hidden />Keep current
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => startEdit(f)} disabled={disabled} aria-label={`Edit ${label}`}>
                    <Pencil className="w-3.5 h-3.5 mr-1" aria-hidden />Edit
                  </Button>
                </div>
              )}
            </div>
            <dl className="grid gap-1 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-fg-subtle">Current</dt>
                <dd className="text-fg-muted break-words">{catalogDisplayValue(f.field, f.current) || <em>empty</em>}</dd>
              </div>
              <div>
                <dt className="text-fg-subtle">{isChosen && !accepted ? 'Your edit' : 'Detected in this version'}</dt>
                <dd className="text-fg break-words">
                  {catalogDisplayValue(f.field, isChosen ? edits[f.field] : f.value) || <em>empty</em>}
                </dd>
              </div>
            </dl>
            {editing === f.field && (
              <div className="space-y-2">
                <FormField label={`New ${label.toLowerCase()}`} error={draftError ?? undefined} hint={CATALOG_FIELD_HINTS[f.field]}>
                  {CATALOG_FIELD_EDITOR[f.field] === 'textarea' ? (
                    <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} disabled={disabled} />
                  ) : CATALOG_FIELD_EDITOR[f.field] === 'select' ? (
                    <Select value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled}>
                      <option value="">— None —</option>
                      {PLUGIN_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_DISPLAY_NAMES[c]}</option>)}
                    </Select>
                  ) : (
                    <Input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled} />
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
  );
}
