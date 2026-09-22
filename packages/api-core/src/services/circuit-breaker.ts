// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-target circuit breaker for service-to-service calls.
 *
 * The shared {@link InternalHttpClient} already has timeouts, a bounded socket
 * pool, and bounded retry-with-jitter — but no load-shedding. Under a sustained
 * downstream brownout every caller keeps paying `timeout × (maxRetries+1)` per
 * request, saturating the socket pool and turning one slow dependency into a
 * fleet-wide latency cascade (the classic retry storm). Worse for fail-CLOSED
 * dependencies (compliance): a brownout there blocks plugin/pipeline creation
 * with full retry latency on every request.
 *
 * This breaker short-circuits that: after `failureThreshold` consecutive
 * failures to a target it OPENS and fast-fails (no network, no retries) for
 * `cooldownMs`, then allows a single half-open probe. A fail-closed caller still
 * fails closed — just immediately, instead of after the full retry budget; a
 * fail-open caller (createSafeClient) gets its `null` immediately.
 *
 * State is keyed by `host:port` plus a route class ({@link circuitBreakerKey})
 * in a process-level registry so it is shared even when callers mint a fresh
 * client per request — one bad target trips once, not once-per-client — while
 * one failing surface of a service can't shed traffic to its other surfaces. Disable entirely with `S2S_BREAKER_ENABLED=false`.
 */

import { envInt, envBool } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('circuit-breaker');

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Consecutive failures that trip the breaker from closed → open. */
  failureThreshold: number;
  /** How long to stay open before allowing a half-open probe (ms). */
  cooldownMs: number;
  /** Master switch — when false, allowRequest() is always true and no state moves. */
  enabled: boolean;
}

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: envInt('S2S_BREAKER_THRESHOLD', 5, { min: 1 }),
  cooldownMs: envInt('S2S_BREAKER_COOLDOWN_MS', 10000, { min: 1 }),
  enabled: envBool('S2S_BREAKER_ENABLED', true),
};

/**
 * A single target's breaker. Not concurrency-locked (JS is single-threaded per
 * event loop); `probeInFlight` gates half-open to one in-flight probe so a burst
 * during cooldown doesn't stampede the recovering downstream.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  /** When the current half-open probe was admitted (for expiring a stuck probe). */
  private probeStartedAt = 0;

  constructor(
    private readonly key: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG,
  ) {}

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Whether a request may proceed. Transitions open→half-open once the cooldown
   * elapses and lets exactly ONE probe through. Returns false when open (or a
   * probe is already in flight) — the caller must fast-fail without any network.
   */
  allowRequest(): boolean {
    if (!this.config.enabled) return true;
    if (this.state === 'closed') return true;
    const now = Date.now();
    if (this.state === 'open') {
      if (now - this.openedAt >= this.config.cooldownMs) {
        this.state = 'half-open';
        this.admitProbe(now);
        return true;
      }
      return false;
    }
    // half-open: allow only a single probe at a time — but a probe that has been
    // in flight longer than the cooldown is presumed lost (its caller never
    // reported back: hung socket, swallowed promise). Without this expiry the
    // breaker would stay half-open with the gate shut FOREVER, fast-failing
    // every request to a downstream that may long since have recovered.
    if (this.probeInFlight && now - this.probeStartedAt < this.config.cooldownMs) return false;
    if (this.probeInFlight) emitCounter('s2s_circuit_probe_expired_total', { target: this.key });
    this.admitProbe(now);
    return true;
  }

  private admitProbe(now: number): void {
    this.probeInFlight = true;
    this.probeStartedAt = now;
  }

  /** A logical request succeeded (2xx/3xx/4xx that isn't a downstream fault). */
  recordSuccess(): void {
    if (!this.config.enabled) return;
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    if (this.state !== 'closed') {
      logger.info('circuit closed (downstream recovered)', { target: this.key });
      this.state = 'closed';
    }
  }

  /** A logical request failed (connection error, timeout, or 5xx response). */
  recordFailure(): void {
    if (!this.config.enabled) return;
    this.probeInFlight = false;
    this.consecutiveFailures++;
    // A failed half-open probe means the downstream is still bad — re-open.
    if (this.state === 'half-open') {
      this.open();
      return;
    }
    if (this.state === 'closed' && this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    const wasOpen = this.state === 'open';
    this.state = 'open';
    this.openedAt = Date.now();
    if (!wasOpen) {
      logger.warn('circuit opened — shedding load to target', {
        target: this.key,
        consecutiveFailures: this.consecutiveFailures,
        cooldownMs: this.config.cooldownMs,
      });
      emitCounter('s2s_circuit_opened_total', { target: this.key });
    }
  }
}

const registry = new Map<string, CircuitBreaker>();

/**
 * The breaker key for a target and a ROUTE CLASS. Breakers are per
 * `host:port` + class, so one failing surface of a service (say platform's
 * audit ingest returning 5xx) can't open the breaker for an unrelated one
 * (platform's JWKS / key exchange). The class is a small, caller-chosen label —
 * never derived from the path, which carries ids and would explode the registry.
 */
export function circuitBreakerKey(target: string, routeClass?: string): string {
  return routeClass && routeClass !== DEFAULT_ROUTE_CLASS ? `${target}#${routeClass}` : target;
}

/** The route class of a request that names none. */
export const DEFAULT_ROUTE_CLASS = 'default';

/** Get (or lazily create) the shared breaker for a {@link circuitBreakerKey}. */
export function getCircuitBreaker(key: string): CircuitBreaker {
  let breaker = registry.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker(key);
    registry.set(key, breaker);
  }
  return breaker;
}

/** Test helper: clear all breaker state so suites don't leak across each other. */
export function resetCircuitBreakers(): void {
  registry.clear();
}

/** Thrown by the client when a request is fast-failed because the breaker is open. */
export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(target: string) {
    super(`Circuit open for ${target} — fast-failing to shed load`);
    this.name = 'CircuitOpenError';
  }
}
