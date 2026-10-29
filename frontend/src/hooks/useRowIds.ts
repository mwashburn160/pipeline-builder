// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef } from 'react';

/** What {@link useRowIds} hands back: the keys, plus the three list mutations. */
export interface RowIds<T> {
  /** One stable id per element of `value`, in the same order. Use as the React key. */
  ids: string[];
  /** Append an item. */
  add: (item: T) => void;
  /** Remove the item at `index`, dropping its id with it. */
  remove: (index: number) => void;
  /** Replace the item at `index`, keeping its id. */
  replace: (index: number, item: T) => void;
}

/**
 * Stable React keys for a list of free-text rows, plus the mutations that keep
 * them in lockstep.
 *
 * Every one of these editors renders rows whose content is user-typed and may be
 * empty or duplicated, so neither the array index nor a value-derived key is
 * safe: keying by index makes React reuse the wrong DOM node after a mid-list
 * removal (the classic symptom is the focused input keeping the removed row's
 * text, or a value jumping up one row), and keying by value collides the moment
 * two rows are blank. So each row gets a counter-issued id that lives only on
 * the client and is never serialized into the `onChange` payload.
 *
 * Five components had grown their own copy of this — MetadataEditor, VarsEditor,
 * EnvEditor, StringArrayEditor and RuleEditor's condition rows — differing only
 * in the id prefix. The part worth sharing is not the three lines of bookkeeping
 * but the pairing: `remove` MUST drop the id at that index before calling
 * `onChange`, because the length reconciliation below only ever adjusts the
 * TAIL. A copy that forgets it looks correct (the lengths still match) and
 * misbehaves only on mid-list removal, which is exactly the case the ids exist
 * for.
 *
 * The ids are reconciled during render rather than in an effect, so they are
 * correct on the first paint and when the PARENT replaces the list (a form reset
 * or a loaded entity), not just when this component mutates it.
 *
 * @param value    the list being edited
 * @param onChange receives the new list for every mutation
 * @param prefix   namespaces the ids (`meta`, `var`, `env`, …) so two editors on
 *                 one page can't produce the same key
 */
export function useRowIds<T>(value: T[], onChange: (next: T[]) => void, prefix: string): RowIds<T> {
  const counterRef = useRef(0);
  const idsRef = useRef<string[]>([]);
  // Append ids for rows added here or by the parent, and truncate on a full
  // external reset. Mid-list removal is handled in `remove`, so this only ever
  // adjusts the tail.
  while (idsRef.current.length < value.length) idsRef.current.push(`${prefix}-${counterRef.current++}`);
  if (idsRef.current.length > value.length) idsRef.current = idsRef.current.slice(0, value.length);

  return {
    ids: idsRef.current,
    add: (item: T) => onChange([...value, item]),
    remove: (index: number) => {
      idsRef.current = idsRef.current.filter((_, i) => i !== index);
      onChange(value.filter((_, i) => i !== index));
    },
    replace: (index: number, item: T) => {
      const next = [...value];
      next[index] = item;
      onChange(next);
    },
  };
}
