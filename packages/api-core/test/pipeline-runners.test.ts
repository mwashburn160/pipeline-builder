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
import { OPERATOR_GRANTED_FEATURE_FLAGS } from '../src/types/feature-flags.js';
import {
  EXPECTED_OUTCOMES, isRunnerErrorCode, isTerminalExecutionStatus, PENDING_RUN_REQUEST_STATUSES, RUN_REQUEST_ACTIONS,
  RUN_REQUEST_MAX_LIFETIME_SECONDS, RUN_REQUEST_STATUSES, RUN_REQUEST_TTL_MS, RUNNER_ACTIONS, RUNNER_API_ERROR_CODES,
  RUNNER_ERROR_CODES, RUNNER_ERRORS, RUNNER_FEATURE, RUNNER_OUTCOMES, RUNNER_REPLY_ERROR_CODES, runnerErrorStatus,
  RUNNER_DELIVERY_FAILURE_CLASSES, TERMINAL_RUN_REQUEST_STATUSES,
} from '../src/types/pipeline-runners.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('pipeline-runners catalog', () => {
  it('imports nothing at runtime (the browser and the runner Lambda bundle load it)', () => {
    const src = readFileSync(join(pkgDir, 'src/types/pipeline-runners.ts'), 'utf-8');
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*;/gm)];
    expect(imports.every((m) => m[1] !== undefined)).toBe(true);
  });

  it('names the operator-granted runner feature', () => {
    expect(OPERATOR_GRANTED_FEATURE_FLAGS).toContain(RUNNER_FEATURE);
  });

  it('splits request statuses into pending and terminal, with nothing left over', () => {
    expect([...PENDING_RUN_REQUEST_STATUSES, ...TERMINAL_RUN_REQUEST_STATUSES].sort()).toEqual([...RUN_REQUEST_STATUSES].sort());
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
    expect(RUNNER_ERROR_CODES.filter((c) => RUNNER_ERRORS[c].retryable).sort()).toEqual(['DUPLICATE', 'NOT_YET_VISIBLE', 'RUNNER_ERROR']);
    for (const c of RUNNER_ERROR_CODES) if (RUNNER_ERRORS[c].retryable) expect(RUNNER_ERRORS[c].category).toBe('runner');
  });

  it('partitions the codes by category', () => {
    expect(RUNNER_API_ERROR_CODES.length + RUNNER_REPLY_ERROR_CODES.length + 2).toBe(RUNNER_ERROR_CODES.length);
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
