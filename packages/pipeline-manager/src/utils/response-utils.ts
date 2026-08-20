// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// API response-envelope parsing. Split out of output-utils (which is about
// rendering) — this is purely about reading the `{ success, data }` shapes the
// platform returns and pulling out single entities / lists.

import { printError, printWarning } from './output-utils.js';

/**
 * Unwrap a sendSuccess API envelope: { success, statusCode, data: { ... } }
 * Returns the inner `data` object, or the original response if not wrapped.
 */
export function unwrapEnvelope(response: unknown): Record<string, unknown> {
  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    if ('success' in obj && 'data' in obj && obj.data && typeof obj.data === 'object') {
      return obj.data as Record<string, unknown>;
    }
    return obj;
  }
  return {};
}

/**
 * Extract a single entity from an API response, handling envelope formats.
 * Tries: payload[entityKey], payload directly (if identifierKey exists), or undefined.
 */
export function extractSingleResponse<T>(response: unknown, entityKey: string, identifierKey: string): T | undefined {
  const payload = unwrapEnvelope(response);
  // Direct entity: payload has the identifier (e.g. payload.id, payload.props, payload.name)
  if (identifierKey in payload) return payload as unknown as T;
  // Nested under entity key: payload.pipeline, payload.plugin
  const nested = payload[entityKey] as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object' && identifierKey in nested) return nested as unknown as T;
  return undefined;
}

export interface ListResponseResult<T> {
  items: T[];
  total?: number;
  hasMore: boolean;
}

/**
 * Extract items from an API list response, handling multiple response formats.
 * Supports: `{ <key>: T[] }`, `{ items: T[] }`, `T[]`, or invalid formats.
 */
export function extractListResponse<T>(response: unknown, itemsKey: string): ListResponseResult<T> {
  if (Array.isArray(response)) {
    return { items: response, total: undefined, hasMore: false };
  }

  if (response && typeof response === 'object') {
    const obj = unwrapEnvelope(response);

    // A `{ success, data: [...] }` envelope unwraps to the bare array — return it directly
    // (the `itemsKey in obj` / `'items' in obj` checks below are false for an array, so
    // without this such list envelopes would silently yield zero items).
    if (Array.isArray(obj)) {
      return { items: obj as T[], total: undefined, hasMore: false };
    }

    // Extract pagination metadata if present
    const pagination = obj.pagination as Record<string, unknown> | undefined;
    const total = (pagination?.total ?? obj.total) as number | undefined;
    const hasMore = ((pagination?.hasMore ?? obj.hasMore) as boolean) || false;

    // Try primary key (e.g. 'pipelines', 'plugins')
    if (itemsKey in obj && Array.isArray(obj[itemsKey])) {
      return { items: obj[itemsKey] as T[], total, hasMore };
    }

    // Try generic 'items' key
    if ('items' in obj && Array.isArray(obj.items)) {
      return { items: obj.items as T[], total, hasMore };
    }

    printWarning('Unexpected response format, attempting to handle');
    return { items: [], total: undefined, hasMore: false };
  }

  printError('Invalid response format from API');
  throw new Error('Unexpected API response format');
}
