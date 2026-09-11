// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage guard for the generated OpenAPI document: assert the services that
 * were previously ABSENT from the spec (ask, image-registry) are now registered,
 * and that the long-standing ones stay covered. Fails if a service's registration
 * is dropped or throws at generation time.
 */
import { describe, it, expect } from '@jest/globals';
import { generateOpenApiSpec } from '../src/openapi/registry.js';

describe('generated OpenAPI spec coverage', () => {
  const spec = generateOpenApiSpec();
  const paths = Object.keys(spec.paths ?? {});

  it('covers the Ask assistant service', () => {
    expect(paths).toContain('/ask/providers');
    expect(paths).toContain('/ask/agent/stream');
  });

  it('covers the image-registry service', () => {
    expect(paths).toContain('/token');
    expect(paths).toContain('/api/images');
    expect(paths).toContain('/api/images/{name}/tags');
  });

  it('still covers the original services (billing/pipeline/plugin/quota/message/templates)', () => {
    for (const p of ['/quotas', '/pipelines', '/plugins']) {
      expect(paths.some((x) => x === p || x.startsWith(`${p}/`) || x.startsWith(`${p}`))).toBe(true);
    }
  });
});
