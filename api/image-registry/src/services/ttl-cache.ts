// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A bounded, process-local TTL cache. Entries expire after their TTL; at
 * `maxEntries` the least-recently-used entry is evicted (a read refreshes an
 * entry's position), so an unbounded key space (orgs, repositories, scope
 * sets) can never grow the map without limit. Values are stored by reference —
 * for objects that must not be cloned (clients, frozen sets).
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries: number, private readonly defaultTtlMs: number) {}

  /** The live value for `key`, or undefined (an expired entry is dropped). */
  get(key: string, now: number = Date.now()): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number = this.defaultTtlMs, now: number = Date.now()): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Drop every entry whose key satisfies `match`; returns how many. */
  deleteWhere(match: (key: string) => boolean): number {
    let n = 0;
    for (const key of [...this.entries.keys()]) {
      if (match(key)) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }

  clear(): number {
    const n = this.entries.size;
    this.entries.clear();
    return n;
  }

  get size(): number {
    return this.entries.size;
  }
}
