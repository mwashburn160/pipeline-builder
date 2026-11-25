// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-account runner catalog is the one contract four codebases share
 * (the pipeline service, the runner Lambda, the CLI, the dashboard). These
 * assertions hold its internal invariants and the property that lets the
 * browser and the Lambda bundle import it: no runtime imports at all.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import * as catalog from '../src/types/pipeline-runners.js';
import {
  EXPECTED_OUTCOMES, isRunnerErrorCode, isTerminalExecutionStatus, PENDING_RUN_REQUEST_STATUSES, RUN_REQUEST_ACTIONS,
  RUN_REQUEST_MAX_LIFETIME_SECONDS, RUN_REQUEST_STATUSES, RUN_REQUEST_TTL_MS, RUNNER_ACTIONS, RUNNER_API_ERROR_CODES,
  RUNNER_ERROR_CODES, RUNNER_ERRORS, RUNNER_OUTCOMES, RUNNER_REPLY_ERROR_CODES, runnerErrorStatus,
  RUNNER_DELIVERY_FAILURE_CLASSES, TERMINAL_RUN_REQUEST_STATUSES,
  PUBLISHED_RUNNER_KEY_STATES, RUNNER_KEY_STATES, RUNNER_KEY_MODES, RUNNER_LINK_STATUSES,
  RUNNER_KEY_ACTIVATION_DELAY_MS, RUNNER_KEY_RETIRE_WINDOW_MS, RUNNER_KEY_CACHE_MS, RUNNER_JWKS_CACHE_SECONDS,
  RUNNER_KEY_INVALIDATION_CHANNEL, RUNNER_TUNABLE_DEFAULTS, RUNNER_TUNABLE_MINIMUMS, UNREACHABLE_AFTER_FAILURES,
  parseRunnerKeyInvalidation, runnerJwksPath, runnerKeyAgeDays, runnerKeyRevokeConfirmation, runnerTunable,
} from '../src/types/pipeline-runners.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('pipeline-runners catalog', () => {
  it('imports nothing at runtime (the browser and the runner Lambda bundle load it)', () => {
    const src = readFileSync(join(pkgDir, 'src/types/pipeline-runners.ts'), 'utf-8');
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*;/gm)];
    expect(imports.every((m) => m[1] !== undefined)).toBe(true);
  });

  it('has no feature gate and no shared JWKS path (per-org keys, per-runner URL)', () => {
    expect(Object.keys(catalog)).not.toContain('RUNNER_FEATURE');
    expect(Object.keys(catalog)).not.toContain('RUNNER_JWKS_PATH');
    expect(isRunnerErrorCode('RUNNERS_NOT_ENABLED')).toBe(false);
  });

  it('splits request statuses into pending, in progress (a runner job running) and terminal, with nothing left over', () => {
    expect([...PENDING_RUN_REQUEST_STATUSES, ...catalog.IN_PROGRESS_RUN_REQUEST_STATUSES, ...TERMINAL_RUN_REQUEST_STATUSES].sort()).toEqual([...RUN_REQUEST_STATUSES].sort());
  });

  it('expects an outcome for every signed action, each a known outcome', () => {
    expect(Object.keys(EXPECTED_OUTCOMES).sort()).toEqual([...RUNNER_ACTIONS].sort());
    for (const outcomes of Object.values(EXPECTED_OUTCOMES)) for (const o of outcomes) expect(RUNNER_OUTCOMES).toContain(o);
    for (const a of RUN_REQUEST_ACTIONS) expect(RUNNER_ACTIONS).toContain(a);
  });

  it('gives every answered code an HTTP status and no recorded code one', () => {
    for (const code of RUNNER_ERROR_CODES) {
      const meta = RUNNER_ERRORS[code];
      expect([code, meta.httpStatus === null]).toEqual([code, meta.category === 'recorded']);
    }
    for (const code of [...RUNNER_API_ERROR_CODES, ...RUNNER_REPLY_ERROR_CODES]) {
      expect(runnerErrorStatus(code)).toBeGreaterThanOrEqual(400);
    }
  });

  it('retries only the runner answers that are transient', () => {
    // RUNNER_ERROR in a runner's own 4xx reply is final (a bare 5xx is retried as a transport failure, whatever its body).
    expect(RUNNER_ERROR_CODES.filter((c) => RUNNER_ERRORS[c].retryable).sort()).toEqual(['DEPLOY_BUSY', 'DUPLICATE', 'NOT_YET_VISIBLE']);
    for (const c of RUNNER_ERROR_CODES) if (RUNNER_ERRORS[c].retryable) expect(RUNNER_ERRORS[c].category).toBe('runner');
  });

  it('partitions the codes by category', () => {
    // + the recorded ones: RUN_REQUEST_EXPIRED, NO_MATCH, RUNNER_NOT_ELIGIBLE.
    expect(RUNNER_API_ERROR_CODES.length + RUNNER_REPLY_ERROR_CODES.length + 3).toBe(RUNNER_ERROR_CODES.length);
    expect(RUNNER_ERRORS.RUNNER_NOT_ELIGIBLE).toEqual({ httpStatus: null, retryable: false, category: 'recorded' });
    expect(isRunnerErrorCode('NO_RUNNER')).toBe(true);
    expect(isRunnerErrorCode('toString')).toBe(false);
    expect(isRunnerErrorCode(undefined)).toBe(false);
  });

  it('caps a signed request at the request lifetime', () => {
    expect(RUN_REQUEST_MAX_LIFETIME_SECONDS * 1000).toBe(RUN_REQUEST_TTL_MS);
  });

  it.each([['Succeeded', true], ['in-progress', false], ['CANCELLED', true], ['Stopping', false], [null, false]] as const)(
    'execution status %s terminal = %s', (s, terminal) => {
      expect(isTerminalExecutionStatus(s)).toBe(terminal);
    },
  );
});

describe('delivery failure classes', () => {
  it('are the six classes recorded in lastDeliveryError, none a runner error code', () => {
    expect([...RUNNER_DELIVERY_FAILURE_CLASSES]).toEqual(['dns_nxdomain', 'aws_403_url_gone', 'conn_refused', 'timeout', 'http_5xx', 'http_429']);
    expect(RUNNER_DELIVERY_FAILURE_CLASSES.some((c) => isRunnerErrorCode(c))).toBe(false);
  });
});

describe('per-runner JWKS path', () => {
  it('is keyed by the runner id under the public runner mount', () => {
    expect(runnerJwksPath('0b6f9a52-6a0c-4c39-9d77-1f1f6b1c2e3a')).toBe('/api/pipelines/runner/runners/0b6f9a52-6a0c-4c39-9d77-1f1f6b1c2e3a/jwks.json');
  });

  it('encodes the id so it can never escape its path segment', () => {
    expect(runnerJwksPath('../x')).toBe('/api/pipelines/runner/runners/..%2Fx/jwks.json');
  });
});

describe('signing-key codes', () => {
  it.each(['RUNNER_KEY_UNREADABLE', 'RUNNER_KEY_MISSING', 'RUNNER_KEY_EXISTS', 'RUNNER_KEY_TRANSITION_IN_PROGRESS',
    'RUNNER_KEY_NO_ROTATION', 'RUNNER_KEY_RETIRE_TOO_EARLY', 'RUNNER_KEY_INHERITED', 'RUNNER_KEY_MODE_ROOT_ORG'] as const)(
    '%s is a platform 409, never retried', (code) => {
      expect(RUNNER_ERRORS[code]).toEqual({ httpStatus: 409, retryable: false, category: 'platform' });
      expect(RUNNER_API_ERROR_CODES).toContain(code);
    },
  );

  it('a wrong revoke confirmation is a 400', () => {
    expect(runnerErrorStatus('RUNNER_KEY_CONFIRMATION_MISMATCH')).toBe(400);
  });
});

describe('signing-key catalog', () => {
  it('publishes every state but retired', () => {
    expect([...RUNNER_KEY_STATES]).toEqual(['next', 'active', 'retiring', 'retired']);
    expect([...PUBLISHED_RUNNER_KEY_STATES]).toEqual(RUNNER_KEY_STATES.filter((s) => s !== 'retired'));
    expect([...RUNNER_KEY_MODES]).toEqual(['inherit', 'own']);
    expect([...RUNNER_LINK_STATUSES]).toEqual(['linked', 'unlinked', 'not_found', 'ambiguous', 'checking']);
  });

  it('times a rotation as the plan does: 10 min to sign, 1 h to retire, 60 s caches', () => {
    expect(RUNNER_KEY_ACTIVATION_DELAY_MS).toBe(600_000);
    expect(RUNNER_KEY_RETIRE_WINDOW_MS).toBe(3_600_000);
    expect(RUNNER_KEY_CACHE_MS).toBe(60_000);
    expect(RUNNER_JWKS_CACHE_SECONDS).toBe(60);
    // The activation delay covers the route cache.
    expect(RUNNER_KEY_ACTIVATION_DELAY_MS).toBeGreaterThan(RUNNER_JWKS_CACHE_SECONDS * 1000);
  });

  it('takes the last six characters of the kid as the revoke confirmation', () => {
    expect(runnerKeyRevokeConfirmation('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs')).toBe('RGC9Xs');
  });

  it('counts whole days of key age, never negative', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    expect(runnerKeyAgeDays('2025-11-19T12:00:00Z', now)).toBe(365);
    expect(runnerKeyAgeDays(new Date('2026-11-19T11:00:00Z'), now)).toBe(0);
    expect(runnerKeyAgeDays('2026-11-20T00:00:00Z', now)).toBe(0);
    expect(runnerKeyAgeDays('not a date', now)).toBe(0);
    // An unparseable `now` must not leak NaN into the DTO's ageDays / the age gauge.
    expect(runnerKeyAgeDays('2025-11-19T12:00:00Z', new Date('nope'))).toBe(0);
    expect(runnerKeyAgeDays('2025-11-19T12:00:00Z', Number.NaN)).toBe(0);
  });
});

describe('tunable limits', () => {
  it('ships the plan defaults', () => {
    expect(RUNNER_TUNABLE_DEFAULTS).toEqual({
      RUN_REQUESTS_PER_MINUTE: '6',
      MAX_PENDING_PER_ORG: '500',
      MAX_IN_FLIGHT_PER_RUNNER: '8',
      RUNNER_HEALTH_PING_INTERVAL_SECONDS: '60',
      RUNNER_UNHEALTHY_AFTER_PINGS: '2',
      RUNNER_KEY_MAX_AGE_DAYS: '365',
      DEPLOY_REQUESTS_PER_HOUR: '20',
      MAX_ACTIVE_DEPLOYS_PER_RUNNER: '2',
      RUNNER_DEPLOY_DEADLINE_MINUTES: '120',
      RUNNER_DEPLOY_STATUS_POLL_SECONDS: '30',
    });
    expect(Object.keys(RUNNER_TUNABLE_MINIMUMS).sort()).toEqual(Object.keys(RUNNER_TUNABLE_DEFAULTS).sort());
    for (const [k, v] of Object.entries(RUNNER_TUNABLE_DEFAULTS)) {
      expect(Number(v)).toBeGreaterThanOrEqual(RUNNER_TUNABLE_MINIMUMS[k as keyof typeof RUNNER_TUNABLE_MINIMUMS]);
    }
    expect(UNREACHABLE_AFTER_FAILURES).toBe(3);
  });

  it('reads a valid override and falls back on anything else', () => {
    expect(runnerTunable('MAX_PENDING_PER_ORG', {})).toBe(500);
    expect(runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: ' 1200 ' })).toBe(1200);
    expect(runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: '' })).toBe(500);
    expect(runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: 'lots' }, () => undefined)).toBe(500);
    expect(runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: '0' }, () => undefined)).toBe(500);
    expect(runnerTunable('RUNNER_HEALTH_PING_INTERVAL_SECONDS', { RUNNER_HEALTH_PING_INTERVAL_SECONDS: '5' }, () => undefined)).toBe(60);
  });

  it('accepts digits only: a fraction, sign, exponent, hex or unit falls back to the default with one warning per value', () => {
    const warnings: string[] = [];
    const warn = (m: string) => { warnings.push(m); };
    for (const raw of ['7.9', '1e3', '0x10', '+20', '-5', '20s', '1_000', 'Infinity']) {
      expect(runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: raw }, warn)).toBe(500);
    }
    expect(warnings).toHaveLength(8);
    expect(warnings[0]).toMatch(/MAX_PENDING_PER_ORG.*"7\.9".*500/);
    // The same bad value again is not warned twice (settings are re-read per request).
    runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: '7.9' }, warn);
    expect(warnings).toHaveLength(8);
    // Unset and blank are the default without a warning; plain digits are taken.
    runnerTunable('MAX_PENDING_PER_ORG', {}, warn);
    runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: '  ' }, warn);
    expect(runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: '0042' }, warn)).toBe(42);
    expect(warnings).toHaveLength(8);
    // Below the minimum is warned too.
    expect(runnerTunable('MAX_PENDING_PER_ORG', { MAX_PENDING_PER_ORG: '0' }, warn)).toBe(500);
    expect(warnings).toHaveLength(9);
  });
});

describe('RunnerKeyServiceUnavailableError', () => {
  it('is a transient RUNNERS_UNAVAILABLE (never RUNNER_KEY_UNREADABLE), recognised by class or by name', () => {
    const err = new catalog.RunnerKeyServiceUnavailableError('kms_config', 'lookup failed', { cause: new Error('HTTP 503') });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'RunnerKeyServiceUnavailableError', code: 'RUNNERS_UNAVAILABLE', source: 'kms_config', message: 'lookup failed' });
    expect(catalog.RUNNER_ERRORS[err.code].retryable).toBe(false);
    expect(catalog.isRunnerKeyServiceUnavailable(err)).toBe(true);
    // Another bundle's copy of the class.
    const copy = Object.assign(new Error('x'), { name: 'RunnerKeyServiceUnavailableError', code: 'RUNNERS_UNAVAILABLE' });
    expect(catalog.isRunnerKeyServiceUnavailable(copy)).toBe(true);
    for (const other of [new Error('Unsupported state or unable to authenticate data'), { code: 'RUNNERS_UNAVAILABLE' }, null, 'x']) {
      expect(catalog.isRunnerKeyServiceUnavailable(other)).toBe(false);
    }
    expect(catalog.RUNNER_KEY_SERVICE_SOURCES).toEqual(['kms_config', 'kms']);
  });

  it('carries its own unavailable reason (key_service), never the operator pause', () => {
    const err = new catalog.RunnerKeyServiceUnavailableError('kms', 'throttled');
    expect(err.reason).toBe('key_service');
    expect(catalog.RUNNERS_UNAVAILABLE_REASONS).toEqual(['paused', 'encryption_not_configured', 'key_service']);
  });
});

describe('key invalidation messages', () => {
  it('names one channel', () => {
    expect(RUNNER_KEY_INVALIDATION_CHANNEL).toBe('runner-keys:invalidate');
  });

  it('round-trips both kinds', () => {
    const keys = { v: 1, kind: 'keys', origin: 'pipeline-1', orgIds: ['a', 'b'] } as const;
    const pause = { v: 1, kind: 'pause', origin: 'pipeline-2', paused: true } as const;
    expect(parseRunnerKeyInvalidation(JSON.stringify(keys))).toEqual(keys);
    expect(parseRunnerKeyInvalidation(JSON.stringify(pause))).toEqual(pause);
  });

  it.each([
    'not json', 'null', '[]', '{"v":2,"kind":"keys","origin":"x","orgIds":[]}',
    '{"v":1,"kind":"keys","origin":"x","orgIds":[1]}', '{"v":1,"kind":"keys","orgIds":["a"]}',
    '{"v":1,"kind":"pause","origin":"x","paused":"yes"}', '{"v":1,"kind":"other","origin":"x"}',
  ])('rejects %s', (raw) => {
    expect(parseRunnerKeyInvalidation(raw)).toBeNull();
  });
});

describe('signing-key audit actions', () => {
  it('are remote audit actions the pipeline service may emit', async () => {
    const { isRemoteAuditAction } = await import('../src/types/remote-audit-actions.js');
    for (const a of [
      'pipeline.runner.key.generate', 'pipeline.runner.key.rotate', 'pipeline.runner.key.cancel', 'pipeline.runner.key.finish',
      'pipeline.runner.key.revoke', 'pipeline.runner.key.mode', 'pipeline.runner.key.promote', 'pipeline.runner.key.retire',
      'pipeline.runner.key.system_revoke', 'pipeline.runner.key.reencrypt',
      'pipeline.runner.deliveries.pause', 'pipeline.runner.deliveries.resume', 'pipeline.runner.link.refresh',
    ]) expect([a, isRemoteAuditAction(a)]).toEqual([a, true]);
  });
});

describe('deploy-job protocol metadata (a toolchain release records it from its cdk-synth half)', () => {
  it('reads a whole number >= 1 from the cdk-synth metadata key, as a number or digit string', () => {
    const k = catalog.DEPLOY_JOB_PROTOCOL_METADATA_KEY;
    expect(k).toBe('pb:deploy-job:protocol');
    expect(catalog.deployJobProtocolFromMetadata({ [k]: catalog.DEPLOY_JOB_PROTOCOL_VERSION })).toBe(catalog.DEPLOY_JOB_PROTOCOL_VERSION);
    expect(catalog.deployJobProtocolFromMetadata({ [k]: ' 2 ' })).toBe(2);
  });

  it.each([null, undefined, 'x', {}, { 'pb:deploy-job:protocol': 0 }, { 'pb:deploy-job:protocol': 1.5 }, { 'pb:deploy-job:protocol': '1a' }, { 'pb:deploy-job:protocol': true }])(
    'is null for %p', (metadata) => {
      expect(catalog.deployJobProtocolFromMetadata(metadata)).toBeNull();
    });
});
