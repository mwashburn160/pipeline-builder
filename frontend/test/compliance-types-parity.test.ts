// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `ComplianceViolation` / `ComplianceCheckResult` describe what the compliance
 * SERVICE sends, so the frontend re-exports api-core's definitions rather than
 * keeping its own. The local copies had already drifted (`severity` narrowed to
 * the rule-severity union, `policyId` losing its `| null`), which is the kind of
 * silent divergence this guards against.
 *
 * Structural assignability in BOTH directions is the assertion — it fails to
 * compile the moment either shape gains, loses or renarrows a field. The
 * runtime body only needs to exist for jest to run the file.
 */

import { describe, it, expect } from '@jest/globals';
import type { ComplianceCheckResult, ComplianceViolation } from '../src/types/compliance';
import type {
  ComplianceCheckResult as CoreCheckResult,
  ComplianceViolation as CoreViolation,
} from '@pipeline-builder/api-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const violationsMatch: Exact<ComplianceViolation, CoreViolation> = true;
const resultsMatch: Exact<ComplianceCheckResult, CoreCheckResult> = true;

describe('compliance wire types', () => {
  it('are the api-core definitions, not a local copy', () => {
    expect(violationsMatch).toBe(true);
    expect(resultsMatch).toBe(true);
  });

  it('are re-exported, so a future edit cannot re-declare them locally', () => {
    const src = readFileSync(join(__dirname, '../src/types/compliance.ts'), 'utf8');
    expect(src).toMatch(/export type \{[^}]*ComplianceViolation[^}]*\} from '@pipeline-builder\/api-core'/);
    expect(src).not.toMatch(/interface ComplianceViolation\b/);
    expect(src).not.toMatch(/interface ComplianceCheckResult\b/);
  });
});
