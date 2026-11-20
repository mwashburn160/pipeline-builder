// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system-org shared-base pass (plan "Shared base images"): when a targeted
 * finding sits in a layer of a shared platform base (api-core
 * PLUGIN_BASE_IMAGES — plugin-base, plugin-go-base, …), that base is rebuilt
 * ONCE per base and findings set — the first dependant to need it rebuilds it,
 * every other dependant reuses the result — under its own concurrency
 * (PLUGIN_REMEDIATION_BASE_CONCURRENCY), and the dependants then build FROM it.
 *
 * The rebuilt base is an overlay of the current `<base>:<tag>` (upgrading the
 * named OS packages in place) verified with the base's own smokeTest, pushed to
 * the SYSTEM namespace as `system/<base name>:<tag>-r<hash>` — the plugin
 * service's credential cannot push `library/*` (image-registry grants that to
 * the deploy-bootstrap identity only), so `library/<base>` itself is left for
 * the next deploy-time base build.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { chooseFixVersion, createLogger, errorMessage, SYSTEM_ORG_ID, type PluginBaseImage, type PluginScanFinding } from '@pipeline-builder/api-core';

import { keepLease, release, tryAcquire, type SemaphoreRedis } from './concurrency.js';
import { overlayDockerfile } from './overlay.js';
import { overlayCommand } from './patchers/index.js';
import type { RemediationPorts } from './ports.js';
import { remediationConfig } from '../../config.js';
import { getHealthRedisConnection } from '../../queue/connections.js';

const logger = createLogger('plugin-remediation-base');

/** How long a dependant waits for another worker's rebuild of the same base. */
const WAIT_MS = 30 * 60_000;
const POLL_MS = 15_000;
const MARKER_TTL_S = 24 * 3600;

export interface BasePassRedis extends SemaphoreRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** The base's identity for one findings set (the "once per pass" key). */
export function basePassKey(base: PluginBaseImage, findings: readonly PluginScanFinding[]): string {
  const set = [...new Set(findings.map((f) => `${f.id}|${f.purl}|${f.packageVersion}`))].sort().join('\n');
  return `plugin:remediation:base:${base.image}:${createHash('sha256').update(set).digest('hex').slice(0, 16)}`;
}

export async function ensureSharedBaseRebuilt(
  base: PluginBaseImage,
  findings: readonly PluginScanFinding[],
  ports: RemediationPorts,
  deps: { redis?: BasePassRedis; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<string | null> {
  const redis = deps.redis ?? (getHealthRedisConnection() as unknown as BasePassRedis);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const key = basePassKey(base, findings);
  const done = await redis.get(`${key}:done`);
  if (done) return done === 'failed' ? null : done;

  // One rebuilder per key; everyone else waits for its marker.
  const owner = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const mine = await redis.set(`${key}:lock`, owner, 'PX', WAIT_MS, 'NX');
  if (mine !== 'OK') {
    const until = now() + WAIT_MS;
    while (now() < until) {
      await sleep(POLL_MS);
      const marker = await redis.get(`${key}:done`);
      if (marker) return marker === 'failed' ? null : marker;
    }
    return null;
  }

  const until = now() + WAIT_MS;
  while (!await tryAcquire(redis, 'base', key, remediationConfig().baseConcurrency)) {
    if (now() > until) { await redis.del(`${key}:lock`); return null; }
    await sleep(POLL_MS);
  }
  const stop = keepLease(redis, 'base', key);
  try {
    const ref = await rebuildBase(base, findings, ports);
    await redis.set(`${key}:done`, ref ?? 'failed', 'EX', MARKER_TTL_S);
    return ref;
  } catch (err) {
    logger.warn('Shared base rebuild failed; dependants build without it', { base: base.image, error: errorMessage(err) });
    await redis.set(`${key}:done`, 'failed', 'EX', MARKER_TTL_S);
    return null;
  } finally {
    stop();
    await release(redis, 'base', key).catch(() => undefined);
    await redis.del(`${key}:lock`).catch(() => undefined);
  }
}

async function rebuildBase(base: PluginBaseImage, findings: readonly PluginScanFinding[], ports: RemediationPorts): Promise<string | null> {
  const current = await ports.resolveDigest(base.image);
  if (!current) return null;
  const [name, tag] = base.image.split(':') as [string, string];
  const fromRef = `${ports.imageReference({ orgId: SYSTEM_ORG_ID, name, digest: current }).replace(/\/system\//, '/library/')}`;
  const commands = chooseFixVersion(findings)
    .filter((c) => c.fixVersion && (c.packageType === 'deb' || c.packageType === 'apk' || c.packageType === 'rpm'))
    .map((c) => overlayCommand({ ...c, fixVersion: c.fixVersion! }, c.locations))
    .filter((x): x is string => x !== null);
  const df = overlayDockerfile({ baseRef: fromRef, user: '', commands });
  if (!df) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-rem-base-'));
  try {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), df);
    const version = `${tag}-r${basePassKey(base, findings).slice(-8)}`;
    const digest = await ports.build({ orgId: SYSTEM_ORG_ID, name, version, contextDir: dir, dockerfile: 'Dockerfile', buildArgs: {} });
    const ref = { orgId: SYSTEM_ORG_ID, name, digest };
    if (base.smokeTest) await ports.smokeTest(ref, base.smokeTest);
    logger.info('Shared base rebuilt for remediation', { base: base.image, digest });
    return ports.imageReference(ref);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
