// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef } from 'react';

/**
 * Has the user edited this form since it opened?
 *
 * Snapshots the field values on first render and compares by value on every
 * render after. Feeds `<Modal dirty>` so a stray backdrop click or Escape asks
 * before discarding an edit instead of throwing it away.
 *
 * Compare-by-serialization is deliberate: form state is plain strings, numbers,
 * booleans and small arrays/objects, and it means a caller can pass an inline
 * object literal (`useIsDirty({ name, description })`) without memoizing it.
 * Don't pass values holding functions, class instances or cyclic structures.
 */
export function useIsDirty(values: unknown): boolean {
  const initial = useRef<string | null>(null);
  const current = JSON.stringify(values ?? null);
  if (initial.current === null) initial.current = current;
  return initial.current !== current;
}
