// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The mask every read-back alert-destination target carries (see the service's `maskTarget`). */
export const TARGET_MASK = '••••';

/**
 * True when `target` carries the read-back mask: it is (or was copied from) a
 * masked GET, never a real destination. Such a value must never be stored — on
 * update it means "keep the stored target", on create it is refused.
 */
export function isMaskedTarget(target: string | undefined | null): boolean {
  return typeof target === 'string' && target.includes(TARGET_MASK);
}
