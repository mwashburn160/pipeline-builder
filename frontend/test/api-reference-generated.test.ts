// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `docs/api-reference.md` → its ROUTE INDEX is generated from the route-table
 * snapshots by `scripts/generate-api-reference.mjs`, and must match what the
 * current snapshots would generate.
 *
 * Why: the hand-written endpoint tables drifted until 67 plugin routes, about 16
 * pipeline routes and the whole Ask service appeared in no doc. The snapshots are
 * rewritten by each service's route-coverage test, so a route added without
 * `npm run generate:api-reference` fails HERE instead of shipping undocumented.
 */
import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FRONTEND = resolve(__dirname, '..');
const SCRIPT = join(FRONTEND, 'scripts', 'generate-api-reference.mjs');
const DOC = resolve(FRONTEND, '..', 'docs', 'api-reference.md');
const TABLES = join(FRONTEND, 'src', 'generated', 'route-table');
const PROBES = new Set(['/health', '/ready', '/metrics', '/warmup']);

interface Route { method: string; path: string; internalCallers?: string[] }

function run(args: string[], doc?: string): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...(doc ? { API_REFERENCE_DOC: doc } : {}) },
      stdio: 'pipe',
    });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    return { status: e.status ?? 1, stderr: e.stderr?.toString() ?? '' };
  }
}

describe('docs/api-reference.md route index', () => {
  it('is up to date with the route-table snapshots (run `npm run generate:api-reference`)', () => {
    const r = run(['--check']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each(['pipeline', 'plugin', 'ask-agent'])('names every public %s route', (service) => {
    const doc = readFileSync(DOC, 'utf8');
    const routes = JSON.parse(readFileSync(join(TABLES, `${service}.json`), 'utf8')) as Route[];
    const missing = routes
      .filter((r) => !PROBES.has(r.path) && !r.internalCallers?.length)
      .filter((r) => !doc.includes(`| \`${r.method}\` | \`${r.path}\` |`))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('leaves out the probes and the internal-only routes', () => {
    const doc = readFileSync(DOC, 'utf8');
    const index = doc.slice(doc.indexOf('<!-- BEGIN GENERATED: route-index'), doc.indexOf('<!-- END GENERATED: route-index'));
    expect(index).not.toContain('`/health`');
    expect(index).not.toContain('`/internal/plugins/image-references`');
  });

  it('--check fails on a stale index, and a plain run repairs it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-api-ref-'));
    const stale = join(dir, 'api-reference.md');
    const current = readFileSync(DOC, 'utf8');
    // Drop one row from INSIDE the generated section (the hand-written Ask table
    // above it names the same route, so take the last occurrence).
    const at = current.lastIndexOf('| `GET` | `/ask-agent/providers` |');
    writeFileSync(stale, current.slice(0, at) + current.slice(current.indexOf('\n', at) + 1));

    expect(run(['--check'], stale).status).toBe(1);
    expect(run([], stale).status).toBe(0);
    expect(readFileSync(stale, 'utf8')).toBe(current);
  });

  it('refuses a doc without the markers rather than appending somewhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-api-ref-'));
    const bare = join(dir, 'api-reference.md');
    writeFileSync(bare, '# API Reference\n');
    const r = run([], bare);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('missing the route-index markers');
  });
});
