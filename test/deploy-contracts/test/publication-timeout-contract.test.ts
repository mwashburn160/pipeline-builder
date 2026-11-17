// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Publishing a plugin version is one call from the plugin service to
 * image-registry's `/internal/plugin-publications*` routes, and two timeouts
 * bound it: image-registry's socket timeout on those routes, and the plugin
 * service's client timeout for the call. The SHORTER one cuts the publish.
 *
 * They had drifted: the client waited ten minutes while image-registry answered
 * every request 503 after its default 25 s, so every large image (go, python,
 * java, dotnet...) failed to publish however long the client was willing to
 * wait. This suite keeps the two equal, and keeps both above that default.
 */

import { describe, it, expect } from '@jest/globals';
import { read } from '../src/index.js';

/** A `const|export const NAME = <n>_000;` value in milliseconds. */
function constantMs(rel: string, name: string): number {
  const m = read(rel).match(new RegExp(`(?:export )?const ${name} = ([\\d_]+);`));
  if (!m) throw new Error(`${rel} no longer declares ${name} as a numeric literal`);
  return Number(m[1].replace(/_/g, ''));
}

describe('plugin publication timeouts', () => {
  const route = constantMs('api/image-registry/src/routes/internal-publications.ts', 'PUBLICATION_TIMEOUT_MS');
  const client = constantMs('api/plugin/src/services/ecosystem/registry.ts', 'TIMEOUT_MS');
  const requestDefault = constantMs('packages/api-server/src/api/app-factory.ts', 'REQUEST_TIMEOUT_MS');

  it('the plugin service waits exactly as long as image-registry\'s publication routes allow', () => {
    expect(client).toBe(route);
  });

  it('the publication routes allow longer than the default every request gets', () => {
    expect(route).toBeGreaterThan(requestDefault);
  });

  it('the publication routes apply their timeout before any handler runs', () => {
    const src = read('api/image-registry/src/routes/internal-publications.ts');
    const use = src.indexOf('router.use(PLUGIN_PUBLICATIONS_PATH');
    // Routes mount from their internal contracts (`route(C.<endpoint>)`).
    const firstRoute = src.indexOf('router.post(route(C.');
    expect(use).toBeGreaterThan(-1);
    expect(use).toBeLessThan(firstRoute);
    expect(src.slice(use, firstRoute)).toContain('res.setTimeout(PUBLICATION_TIMEOUT_MS)');
  });

  it('the deciding request waits less than the default request timeout for an execution', () => {
    expect(constantMs('api/plugin/src/services/ecosystem/execution.ts', 'INLINE_BUDGET_MS')).toBeLessThan(requestDefault);
  });
});
