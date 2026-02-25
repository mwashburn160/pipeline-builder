/**
 * @module utils/object
 * @description Object manipulation utilities.
 */

/**
 * Filter an object to only include entries where the value is not `undefined`.
 * Keeps `null`, `false`, `0`, and empty string — only removes `undefined`.
 *
 * Useful for building partial update payloads from validated request bodies.
 *
 * @example
 * ```typescript
 * const body = { name: 'foo', description: undefined, isActive: false };
 * pickDefined(body); // { name: 'foo', isActive: false }
 * ```
 */
export function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
