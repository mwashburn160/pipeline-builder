// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/plugin-compliance — the image facts (`signed`, `scanned`,
 * `vuln*`, `runAsRoot`, `packages`, `tags`) sent to the compliance service at
 * upload (deferred), after the build (real) and on update (stored),.
 */

import { describe, it, expect } from '@jest/globals';
import { PLUGIN_IMAGE_COMPLIANCE_FIELDS } from '@pipeline-builder/api-core';
import {
  postBuildComplianceAttributes, storedComplianceImageFacts, uploadComplianceImageFacts,
} from '../src/helpers/plugin-compliance.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('uploadComplianceImageFacts', () => {
  it('defers every image fact for an image plugin and sends only the inventory tags', () => {
    expect(uploadComplianceImageFacts({ buildType: 'build_image', pluginType: 'CodeBuildStep', keywords: ['sca', ' '], labels: { team: 'sec' } }))
      .toEqual({ attributes: { tags: ['sca', 'team=sec'] }, deferredFields: [...PLUGIN_IMAGE_COMPLIANCE_FIELDS] });
  });

  it('defers nothing for a plugin that runs no image of its own (honestly unsigned/unscanned)', () => {
    for (const row of [
      { buildType: 'metadata_only', pluginType: 'CodeBuildStep', keywords: ['x'] },
      { buildType: 'build_image', pluginType: 'ManualApprovalStep', keywords: [] },
    ]) {
      const facts = uploadComplianceImageFacts(row);
      expect(facts.deferredFields).toEqual([]);
      expect(facts.attributes).toMatchObject({ signed: false, scanned: false, packages: [] });
    }
  });
});

describe('postBuildComplianceAttributes', () => {
  it('sends the real facts of the freshly built image, packages included', () => {
    const { attributes, deferredFields } = postBuildComplianceAttributes({
      buildType: 'build_image',
      pluginType: 'CodeBuildStep',
      imageDigest: DIGEST,
      scannedAt: new Date(),
      vulnCritical: 1,
      vulnHigh: 2,
      vulnMedium: 3,
      vulnLow: 4,
      runAsRoot: false,
      keywords: ['k'],
    }, ['openssl']);
    expect(deferredFields).toEqual([]);
    expect(attributes).toEqual({
      tags: ['k'], signed: true, scanned: true, vulnCritical: 1, vulnHigh: 2, vulnMedium: 3, vulnLow: 4, runAsRoot: false, packages: ['openssl'],
    });
  });

  it('reports an unscannable image as unscanned with no counts, and omits unreadable packages', () => {
    const { attributes } = postBuildComplianceAttributes({
      buildType: 'build_image', pluginType: 'CodeBuildStep', imageDigest: DIGEST, scannedAt: null, vulnCritical: null, runAsRoot: null,
    }, null);
    expect(attributes).toEqual({ tags: [], signed: true, scanned: false });
  });
});

describe('storedComplianceImageFacts', () => {
  it('derives facts from the stored row and defers packages (evaluated post-build)', () => {
    const { attributes, deferredFields } = storedComplianceImageFacts({
      buildType: 'build_image', pluginType: 'CodeBuildStep', imageDigest: 'not-a-digest', scannedAt: null, runAsRoot: true,
    });
    expect(attributes).toEqual({ tags: [], signed: false, scanned: false, runAsRoot: true });
    expect(deferredFields).toEqual(['packages']);
  });
});
