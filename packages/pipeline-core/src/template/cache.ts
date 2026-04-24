// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { tokenize, Token } from './tokenizer';

/**
 * Small LRU cache for parsed token streams. Keys are caller-chosen
 * (typically `${pluginId}:${version}:${fieldPath}`). Capacity is bounded
 * so synth-time resolution in long-running services doesn't leak.
 */
export class TokenCache {
  private readonly max: number;
  private readonly map = new Map<string, Token[]>();

  constructor(max = 100) {
    this.max = max;
  }

  get(key: string): Token[] | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Refresh recency by re-inserting
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, tokens: Token[]): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, tokens);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  invalidate(key: string): void {
    this.map.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const k of Array.from(this.map.keys())) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }

  parse(key: string, source: string): Token[] {
    const hit = this.get(key);
    if (hit) return hit;
    const tokens = tokenize(source);
    this.set(key, tokens);
    return tokens;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// Shared default cache for callers that don't want to own one.
export const defaultTokenCache = new TokenCache();
