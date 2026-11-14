// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A plugin upload passes three timeouts in a row: the loader's curl limit,
 * nginx's proxy timeouts on `location = /api/plugins/upload`, and the plugin
 * service's own socket timeout on the upload route. The SHORTEST one cuts the
 * upload, so raising one of them does nothing unless the others follow.
 *
 * They had drifted: the loader and nginx allowed 900 s while the service
 * defaulted to 300 s, so the ~470 MB pipeline-bootstrap package (a prebuilt
 * image.tar) failed at five minutes however long the loader was told to wait.
 * This suite keeps the three shipped defaults equal, in every target.
 */

import { describe, it, expect } from '@jest/globals';
import { ALL_TARGETS, read } from '../src/index.js';

/** The plugin service's default, in seconds, from the upload route. */
function serviceDefaultSeconds(): number {
  const src = read('api/plugin/src/routes/upload-plugin.ts');
  const m = src.match(/envInt\(\s*'PLUGIN_UPLOAD_TIMEOUT_MS',\s*([\d_]+)/);
  if (!m) throw new Error('upload-plugin.ts no longer reads PLUGIN_UPLOAD_TIMEOUT_MS with a numeric default');
  return Number(m[1].replace(/_/g, '')) / 1000;
}

/** The loader's default `UPLOAD_TIMEOUT`, in seconds. */
function loaderDefaultSeconds(): number {
  const m = read('deploy/bin/load-plugins.sh').match(/^UPLOAD_TIMEOUT=(\d+)$/m);
  if (!m) throw new Error('load-plugins.sh no longer sets a numeric UPLOAD_TIMEOUT default');
  return Number(m[1]);
}

/** The body of `location = /api/plugins/upload { … }` in one target's nginx.conf. */
function uploadLocation(target: string): string {
  const conf = read(`${target}/nginx/nginx.conf`);
  const start = conf.indexOf('location = /api/plugins/upload {');
  if (start < 0) throw new Error(`${target}/nginx/nginx.conf has no exact upload location`);
  const end = conf.indexOf('\n        }', start);
  return conf.slice(start, end);
}

/** A `<directive> <n>s;` value in seconds, or null when the directive is absent. */
function directiveSeconds(block: string, directive: string): number | null {
  const m = block.match(new RegExp(`\\b${directive}\\s+(\\d+)s;`));
  return m ? Number(m[1]) : null;
}

describe('plugin upload timeouts', () => {
  const service = serviceDefaultSeconds();

  it('the loader waits exactly as long as the service does', () => {
    expect(loaderDefaultSeconds()).toBe(service);
  });

  it.each(ALL_TARGETS)('%s: nginx\'s upload route allows exactly the service timeout', (target) => {
    const block = uploadLocation(target);
    expect({
      proxy_send_timeout: directiveSeconds(block, 'proxy_send_timeout'),
      proxy_read_timeout: directiveSeconds(block, 'proxy_read_timeout'),
      send_timeout: directiveSeconds(block, 'send_timeout'),
    }).toEqual({ proxy_send_timeout: service, proxy_read_timeout: service, send_timeout: service });
  });

  it.each(ALL_TARGETS)('%s: .env.example documents the same default', (target) => {
    const m = read(`${target}/.env.example`).match(/^#\s*PLUGIN_UPLOAD_TIMEOUT_MS=(\d+)$/m);
    expect(m && Number(m[1]) / 1000).toBe(service);
  });
});
