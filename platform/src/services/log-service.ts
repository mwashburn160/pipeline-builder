/**
 * @module services/log-service
 * @description Loki HTTP client for querying logs with org-scoped filtering.
 * Constructs LogQL queries server-side to enforce tenant isolation.
 */

import { createLogger } from '@mwashburn160/api-core';
import { config } from '../config';

const logger = createLogger('log-service');

// ============================================================================
// Types
// ============================================================================

export interface LogQueryParams {
  /** Service name filter (e.g., 'pipeline', 'plugin') */
  service?: string;
  /** Log level filter (e.g., 'error', 'warn', 'info', 'debug') */
  level?: string;
  /** Free-text search within log lines */
  search?: string;
  /** Organization ID filter (enforced server-side for non-admins) */
  orgId?: string;
  /** Start time — ISO 8601 or Unix epoch nanoseconds (default: 1h ago) */
  start?: string;
  /** End time — ISO 8601 or Unix epoch nanoseconds (default: now) */
  end?: string;
  /** Max entries to return (default: 100, max: 1000) */
  limit?: number;
  /** Sort direction: 'forward' (oldest first) or 'backward' (newest first, default) */
  direction?: 'forward' | 'backward';
}

export interface LogEntry {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
  parsed: Record<string, unknown>;
}

export interface LogQueryResult {
  entries: LogEntry[];
  stats: {
    entriesReturned: number;
    query: string;
  };
}

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

interface LokiQueryResponse {
  status: string;
  data: {
    resultType: string;
    result: LokiStream[];
    stats?: Record<string, unknown>;
  };
}

interface LokiLabelResponse {
  status: string;
  data: string[];
}

// ============================================================================
// LogQL Construction
// ============================================================================

/**
 * Escape special characters in a LogQL string literal.
 */
function escapeLogQL(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a LogQL query from filter parameters.
 * The orgId filter is injected server-side and cannot be bypassed by the client.
 */
function buildLogQL(params: LogQueryParams): string {
  // Stream selector
  const streamMatchers: string[] = [];
  if (params.service) {
    streamMatchers.push(`service="${escapeLogQL(params.service)}"`);
  }

  const streamSelector = streamMatchers.length > 0
    ? `{${streamMatchers.join(', ')}}`
    : '{service=~".+"}';

  // Pipeline stages
  const stages: string[] = [];

  // Always parse JSON to access orgId and other fields
  stages.push('json');

  // Org filter (enforced for non-admins, optional for admins)
  if (params.orgId) {
    stages.push(`orgId="${escapeLogQL(params.orgId)}"`);
  }

  // Level filter
  if (params.level) {
    stages.push(`level="${escapeLogQL(params.level)}"`);
  }

  // Free-text search
  if (params.search) {
    // Line filter uses |= for case-sensitive contains
    return `${streamSelector} | ${stages.join(' | ')} |= \`${params.search.replace(/`/g, '')}\``;
  }

  return stages.length > 0
    ? `${streamSelector} | ${stages.join(' | ')}`
    : streamSelector;
}

// ============================================================================
// Loki Client
// ============================================================================

async function lokiFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, config.loki.url);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.loki.timeout);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text();
      logger.error('Loki request failed', { status: response.status, path, body });
      throw new Error(`Loki returned ${response.status}: ${body}`);
    }

    return await response.json() as T;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Loki request timed out');
    }
    throw error;
  }
}

/**
 * Parse a Loki log line (JSON string) into structured fields.
 */
function parseLine(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { raw: line };
  }
}

/**
 * Convert nanosecond timestamp to ISO 8601 string.
 */
function nanoToISO(nanoTs: string): string {
  const ms = Math.floor(Number(BigInt(nanoTs) / BigInt(1_000_000)));
  return new Date(ms).toISOString();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Query logs from Loki with org-scoped filtering.
 */
export async function queryLogs(params: LogQueryParams): Promise<LogQueryResult> {
  const query = buildLogQL(params);
  const limit = Math.min(Math.max(params.limit || 100, 1), 1000);

  const now = Date.now();
  const oneHourAgo = now - 3_600_000;

  const lokiParams: Record<string, string> = {
    query,
    limit: String(limit),
    direction: params.direction || 'backward',
    start: params.start || String(oneHourAgo * 1_000_000), // Convert ms to ns
    end: params.end || String(now * 1_000_000),
  };

  logger.debug('Querying Loki', { query, limit });

  const response = await lokiFetch<LokiQueryResponse>('/loki/api/v1/query_range', lokiParams);

  // Transform Loki response into flat entry list
  const entries: LogEntry[] = [];
  for (const stream of response.data.result) {
    for (const [ts, line] of stream.values) {
      entries.push({
        timestamp: nanoToISO(ts),
        line,
        labels: stream.stream,
        parsed: parseLine(line),
      });
    }
  }

  return {
    entries,
    stats: {
      entriesReturned: entries.length,
      query,
    },
  };
}

/**
 * Get available service names from Loki.
 */
export async function getServiceNames(): Promise<string[]> {
  const response = await lokiFetch<LokiLabelResponse>('/loki/api/v1/label/service/values');
  return response.data || [];
}

/**
 * Get available log levels from Loki.
 */
export async function getLogLevels(): Promise<string[]> {
  const response = await lokiFetch<LokiLabelResponse>('/loki/api/v1/label/level/values');
  return response.data || [];
}
