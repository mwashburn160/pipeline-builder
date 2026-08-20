// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

const logger = createLogger('log-service');

// Types

interface LogQueryParams {
  /** Service name filter (e.g., 'pipeline', 'plugin') */
  service?: string;
  /** Log level filter (e.g., 'error', 'warn', 'info', 'debug') */
  level?: string;
  /** Free-text search within log lines */
  search?: string;
  /** Organization ID filter (enforced server-side for non-admins) */
  orgId?: string;
  /** Start time  ISO 8601 or Unix epoch nanoseconds (default: 1h ago) */
  start?: string;
  /** End time  ISO 8601 or Unix epoch nanoseconds (default: now) */
  end?: string;
  /** Max entries to return (default: 100, max: 1000) */
  limit?: number;
  /** Sort direction: 'forward' (oldest first) or 'backward' (newest first, default) */
  direction?: 'forward' | 'backward';
}

interface LogEntry {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
  parsed: Record<string, unknown>;
}

interface LogQueryResult {
  entries: LogEntry[];
  stats: {
    entriesReturned: number;
    query: string;
    /** True when the log backend (Loki) was unreachable and this is a degraded empty result. */
    degraded?: boolean;
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

// LogQL Construction

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
  // Stream selector  use service_name label (extracted from JSON logs by Promtail)
  // to target only API services, not infrastructure containers
  const streamMatchers: string[] = [];
  if (params.service) {
    streamMatchers.push(`service_name="${escapeLogQL(params.service)}"`);
  }

  const streamSelector = streamMatchers.length > 0
    ? `{${streamMatchers.join(', ')}}`
    : '{service_name=~".+"}';

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

// Loki Client

/**
 * tenant header for Loki multi-tenant mode.
 *
 * When Loki runs with `auth_enabled: true`, every read/write requires
 * `X-Scope-OrgID`. We always send this header  Loki ignores it in
 * single-tenant mode (`auth_enabled: false`), so it's safe to set
 * unconditionally and the cutover to multi-tenant just becomes a Loki
 * config change.
 *
 * Defaults to `system` for cross-org admin queries (the dashboards that
 * read every org's logs). Org-scoped queries pass the caller's orgId.
 */
function lokiTenant(tenant?: string): string {
  return tenant && tenant.length > 0 ? tenant: 'system';
}

async function lokiFetch<T>(path: string, params?: Record<string, string>, tenant?: string): Promise<T> {
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
      headers: {
        'Accept': 'application/json',
        'X-Scope-OrgID': lokiTenant(tenant),
      },
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

    // A "Loki returned <status>" error means Loki IS reachable but rejected the
    // request (e.g. a bad LogQL) — a real error, re-thrown as-is for a 5xx.
    if (error instanceof Error && error.message.startsWith('Loki returned ')) throw error;
    // Timeout or a connection-level failure (DNS/ECONNREFUSED) means Loki is
    // unreachable — the normal case on a LEAN deploy, which omits Loki. Tag it so
    // read paths can degrade to an empty result instead of surfacing a 500.
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Loki request timed out'
      : `Loki unreachable: ${errorMessage(error)}`;
    throw Object.assign(new Error(message), { code: LOKI_UNAVAILABLE });
  }
}

/** Marker on errors from an unreachable/absent Loki (vs. a reachable-but-errored one). */
export const LOKI_UNAVAILABLE = 'LOKI_UNAVAILABLE';

/** True when `err` came from an unreachable Loki — callers degrade to empty results. */
export function isLokiUnavailable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === LOKI_UNAVAILABLE);
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

// Public API

/**
 * Loki query service. Wrapped in a class to match the sibling service-class
 * pattern (auditService, organizationService, …). The named function
 * exports below are back-compat shims for the existing controller import
 * (`import * as logService from '../services/log-service.js'`).
 */
class LogService {
  /** Query logs from Loki with org-scoped filtering. */
  async queryLogs(params: LogQueryParams): Promise<LogQueryResult> {
    const query = buildLogQL(params);
    const limit = Math.min(Math.max(params.limit || config.logs.defaultLimit, 1), config.logs.maxLimit);

    const now = Date.now();
    const oneHourAgo = now - config.logs.defaultLookbackMs;

    // Loki expects nanosecond timestamps; frontend sends milliseconds
    const startMs = params.start ? Number(params.start): oneHourAgo;
    const endMs = params.end ? Number(params.end): now;

    const lokiParams: Record<string, string> = {
      query,
      limit: String(limit),
      direction: params.direction || 'backward',
      start: String(startMs * 1_000_000),
      end: String(endMs * 1_000_000),
    };

    logger.debug('Querying Loki', { query, limit });

    // in multi-tenant mode, queries scoped to a single org go to
    // that org's tenant namespace. Org-blind admin queries (when params.orgId
    // is empty) fall back to `system` and require the operator to also
    // configure cross-tenant query permissions in Loki overrides.
    let response: LokiQueryResponse;
    try {
      response = await lokiFetch<LokiQueryResponse>('/loki/api/v1/query_range', lokiParams, params.orgId);
    } catch (err) {
      // LEAN deploys omit Loki — degrade to an empty, `degraded`-flagged result so the
      // Logs page renders an empty state instead of a 500.
      if (isLokiUnavailable(err)) {
        logger.warn('Loki unavailable — returning no log entries');
        return { entries: [], stats: { entriesReturned: 0, query, degraded: true } };
      }
      throw err;
    }

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
   * Get available service names from Loki. Label-value lookups are
   * cross-tenant by nature (the UI populates a dropdown of all services);
   * scoped to the `system` tenant which in multi-tenant deployments must
   * also be configured with `tenant_federation_enabled` so it can read
   * across the per-org streams (see docs/plans/f-2-6-loki-multitenant.md).
   */
  async getServiceNames(): Promise<string[]> {
    try {
      const response = await lokiFetch<LokiLabelResponse>('/loki/api/v1/label/service_name/values', undefined, 'system');
      return response.data || [];
    } catch (err) {
      if (isLokiUnavailable(err)) { logger.warn('Loki unavailable — returning no service names'); return []; }
      throw err;
    }
  }

  /** Get available log levels from Loki. */
  async getLogLevels(): Promise<string[]> {
    try {
      const response = await lokiFetch<LokiLabelResponse>('/loki/api/v1/label/level/values', undefined, 'system');
      return response.data || [];
    } catch (err) {
      if (isLokiUnavailable(err)) { logger.warn('Loki unavailable — returning no log levels'); return []; }
      throw err;
    }
  }
}

export const logService = new LogService();

// Back-compat named-export wrappers — `controllers/log.ts` calls
// `logService.queryLogs(...)` via `import * as logService`, so re-exporting
// these as module-level functions keeps that import shape working without
// editing the controller.
export const queryLogs = logService.queryLogs.bind(logService);
export const getServiceNames = logService.getServiceNames.bind(logService);
export const getLogLevels = logService.getLogLevels.bind(logService);
