// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * api-core's import-time configuration, in one typed object.
 *
 * These are the knobs api-core used to read into module-level constants scattered
 * across its services and schemas. Nothing is read when this module loads,
 * because this module is reached early (through `@pipeline-builder/api-core/testing` and other
 * subpaths). Each VALUE is read on its first access and then cached, so it is
 * read when the module that uses it loads, as before, never earlier. A process
 * that sets `process.env` after an early subpath import, as several suites do,
 * still sees its values. The old
 * constant names (`QUOTA_CHECK_TIMEOUT_MS`, `MAX_PAGE_LIMIT`, …) remain
 * exported as aliases. Each is evaluated when its own module loads, so it reads
 * at the same moment as before.
 *
 * Values that are deliberately read at CALL time (per request, or because tests
 * mutate `process.env` between cases) are NOT here — they stay in the accessor
 * functions next to the code that uses them (e.g. `pluginVulnMaxFindings`,
 * `loadPagerDutyConfig`, `isBillingEnabled`).
 *
 * This module must stay a leaf (it imports only `utils/env`): almost every
 * other api-core module imports it, so anything heavier would create cycles.
 */

import { envBool, envInt } from './utils/env.js';

export interface ApiCoreConfig {
  /** Offset/limit paging bounds shared by every list route and `CrudService`. */
  pagination: {
    /** Largest `limit` a list route accepts (`MAX_PAGE_LIMIT`). */
    maxLimit: number;
    /** `limit` when the caller sends none (`DEFAULT_PAGE_LIMIT`). */
    defaultLimit: number;
    /** Deepest offset before a caller must switch to cursor paging (`MAX_PAGE_OFFSET`). */
    maxOffset: number;
  };
  /** Service-to-service HTTP client defaults (`InternalHttpClient`). */
  httpClient: {
    /** Per-attempt request timeout, ms (`HTTP_CLIENT_TIMEOUT_MS`). */
    timeoutMs: number;
    /** Keep-alive socket cap per client agent (`HTTP_CLIENT_MAX_SOCKETS`). */
    maxSockets: number;
    /** Largest response body buffered before aborting, bytes (`HTTP_CLIENT_MAX_RESPONSE_BYTES`). */
    maxResponseBytes: number;
    /** Retries on a transient failure (`HTTP_CLIENT_MAX_RETRIES`). */
    maxRetries: number;
    /** Base backoff between retries, ms (`HTTP_CLIENT_RETRY_DELAY_MS`). */
    retryDelayMs: number;
  };
  /** Per-target S2S circuit breaker defaults. */
  circuitBreaker: {
    /** Consecutive failures that open the circuit (`S2S_BREAKER_THRESHOLD`). */
    failureThreshold: number;
    /** How long the circuit stays open before a probe, ms (`S2S_BREAKER_COOLDOWN_MS`). */
    cooldownMs: number;
    /** Master switch (`S2S_BREAKER_ENABLED`). */
    enabled: boolean;
  };
  /** Quota client behaviour and the shared usage periods. */
  quota: {
    /** Budget for a counter check before it fails open, ms (`QUOTA_CHECK_TIMEOUT_MS`). */
    checkTimeoutMs: number;
    /** Let `reserve` pass when the quota service did not confirm (`QUOTA_RESERVE_FAIL_OPEN`). */
    reserveFailOpen: boolean;
    /** Metered-increment flush interval, ms; `0` sends each increment alone (`QUOTA_INCREMENT_FLUSH_MS`). */
    incrementFlushMs: number;
    /** Most attribution groups buffered between flushes (`QUOTA_INCREMENT_BUFFER_MAX`). */
    incrementBufferMax: number;
    /** Period every flow counter rolls over on, days (`QUOTA_RESET_DAYS`). */
    resetDays: number;
    /** The `cpuCredits` period, days (`QUOTA_CPU_CREDITS_PERIOD_DAYS`). */
    cpuCreditsPeriodDays: number;
    /** Over-limit grace band, percent, for the banded quota types. */
    gracePct: {
      /** `QUOTA_AUTOMATION_GRACE_PCT`. */
      automationCalls: number;
      /** `QUOTA_STORAGE_GRACE_PCT`. */
      storageBytes: number;
    };
  };
  /** Compliance-service client. */
  compliance: {
    /** Fail open when the compliance service is unreachable (`COMPLIANCE_BYPASS`). */
    bypass: boolean;
    /** Per-attempt timeout of a validation POST, ms (`COMPLIANCE_VALIDATE_TIMEOUT_MS`). */
    validateTimeoutMs: number;
  };
  /** Cache lifetimes of the org AI reads from platform. */
  orgAi: {
    /** An org's AI switch + provider list, ms (`ORG_AI_ACCESS_TTL_MS`). */
    accessTtlMs: number;
    /** A decrypted org key, ms; `0` disables caching (`ORG_AI_KEY_TTL_MS`). */
    keyTtlMs: number;
  };
  /** Request-body size limits enforced by the shared schemas. */
  limits: {
    /** Longest AI prompt accepted, characters (`MAX_PROMPT_LENGTH`). */
    maxPromptLength: number;
    /** Largest message attachment, MiB (`MESSAGE_ATTACHMENT_MAX_MB`). */
    messageAttachmentMaxMb: number;
  };
}

/** A config tree whose leaves are factories (`() => value`). */
type Lazy<T> = { [K in keyof T]: T[K] extends object ? Lazy<T[K]> : () => T[K] };

/**
 * Build an object whose every leaf is read from its factory on first access and
 * then cached, so each env var is read once but no earlier than it is used.
 */
function lazyTree<T extends object>(factories: Lazy<T>): T {
  const out = {} as T;
  for (const key of Object.keys(factories) as Array<keyof T>) {
    const factory = (factories as Record<keyof T, unknown>)[key];
    if (typeof factory !== 'function') {
      Object.defineProperty(out, key, { value: lazyTree(factory as Lazy<object>), enumerable: true });
      continue;
    }
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get() {
        const value = (factory as () => unknown)();
        Object.defineProperty(out, key, { value, enumerable: true, writable: false, configurable: false });
        return value;
      },
    });
  }
  return out;
}

export const apiCoreConfig: ApiCoreConfig = lazyTree<ApiCoreConfig>({
  pagination: {
    maxLimit: () => envInt('MAX_PAGE_LIMIT', 1000, { min: 1 }),
    defaultLimit: () => envInt('DEFAULT_PAGE_LIMIT', 100, { min: 1 }),
    maxOffset: () => envInt('MAX_PAGE_OFFSET', 100000, { min: 0 }),
  },
  httpClient: {
    timeoutMs: () => envInt('HTTP_CLIENT_TIMEOUT_MS', 5000, { min: 1 }),
    maxSockets: () => envInt('HTTP_CLIENT_MAX_SOCKETS', 64, { min: 1 }),
    maxResponseBytes: () => envInt('HTTP_CLIENT_MAX_RESPONSE_BYTES', 10 * 1024 * 1024, { min: 1 }),
    maxRetries: () => envInt('HTTP_CLIENT_MAX_RETRIES', 2, { min: 0 }),
    retryDelayMs: () => envInt('HTTP_CLIENT_RETRY_DELAY_MS', 200, { min: 0 }),
  },
  circuitBreaker: {
    failureThreshold: () => envInt('S2S_BREAKER_THRESHOLD', 5, { min: 1 }),
    cooldownMs: () => envInt('S2S_BREAKER_COOLDOWN_MS', 10000, { min: 1 }),
    enabled: () => envBool('S2S_BREAKER_ENABLED', true),
  },
  quota: {
    checkTimeoutMs: () => envInt('QUOTA_CHECK_TIMEOUT_MS', 300, { min: 1 }),
    reserveFailOpen: () => envBool('QUOTA_RESERVE_FAIL_OPEN', false),
    incrementFlushMs: () => envInt('QUOTA_INCREMENT_FLUSH_MS', 1000, { min: 0, max: 60_000 }),
    incrementBufferMax: () => envInt('QUOTA_INCREMENT_BUFFER_MAX', 10_000, { min: 1 }),
    resetDays: () => envInt('QUOTA_RESET_DAYS', 3, { min: 1 }),
    cpuCreditsPeriodDays: () => envInt('QUOTA_CPU_CREDITS_PERIOD_DAYS', 30, { min: 1 }),
    gracePct: {
      automationCalls: () => envInt('QUOTA_AUTOMATION_GRACE_PCT', 10, { min: 0, max: 100 }),
      storageBytes: () => envInt('QUOTA_STORAGE_GRACE_PCT', 10, { min: 0, max: 100 }),
    },
  },
  compliance: {
    bypass: () => envBool('COMPLIANCE_BYPASS', false),
    validateTimeoutMs: () => envInt('COMPLIANCE_VALIDATE_TIMEOUT_MS', 4000, { min: 1 }),
  },
  orgAi: {
    accessTtlMs: () => envInt('ORG_AI_ACCESS_TTL_MS', 30_000, { min: 0 }),
    keyTtlMs: () => envInt('ORG_AI_KEY_TTL_MS', 60_000, { min: 0, max: 300_000 }),
  },
  limits: {
    maxPromptLength: () => envInt('MAX_PROMPT_LENGTH', 5000, { min: 1 }),
    messageAttachmentMaxMb: () => envInt('MESSAGE_ATTACHMENT_MAX_MB', 10, { min: 1 }),
  },
});
