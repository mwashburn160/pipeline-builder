// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a purge removes OUTSIDE Postgres for each hard-deleted version, once its
 * row is gone:
 *
 * - its kept-source prefix on RustFS, `plugin-sources/<orgId>/<pluginId>/<version>/`
 *   (the source ZIP, any patched ZIP, the remediation diff and export), by prefix
 *   so nothing is left behind;
 * - its image with its cosign signature and SBOM attestations, through
 *   image-registry's existing `discardPluginImage` contract — UNLESS another
 *   stored version of the same name (live or tombstoned) still carries the same
 *   digest, an identical rebuild whose pipelines pull that manifest.
 *
 * The version's `plugin_remediations` rows go with the row itself (FK ON DELETE
 * CASCADE) — their audit entries were written when each stage happened.
 *
 * A failed delete never blocks the purge: it lands in `plugin_source_orphans`,
 * counts `plugin_source_delete_failures_total{kind}` (alerted), and
 * {@link retryPurgeOrphans} — the purge sweep's retry — tries it again.
 */

import { createLogger, pluginSourceVersionPrefix } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, eq, ne } from 'drizzle-orm';

import { deletePluginSourcePrefix, recordSourceOrphan, retryPluginSourceOrphans } from './plugin-sources.js';
import { imageRepository, type RegistryInfo } from '../helpers/registry-auth.js';
import { discardPluginImage } from '../helpers/supply-chain.js';

const logger = createLogger('plugin-version-purge');

const registryInfo = (): RegistryInfo => Config.get('registry') as RegistryInfo;

/** The fields of a purged version the teardown needs (read BEFORE the row is deleted). */
export interface PurgedVersion {
  id: string;
  orgId: string;
  name: string;
  version: string;
  imageDigest: string | null;
}

/** The namespace-relative repository of an org's plugin (`org-<id>/<name>` / `system/<name>`). */
function relativeRepository(name: string, orgId: string, registry: RegistryInfo): string {
  return imageRepository(name, registry, orgId).slice(`${registry.host}:${registry.port}/`.length);
}

/** Whether another stored version of `row`'s name (any state) carries its digest. */
async function digestStillStored(row: PurgedVersion): Promise<boolean> {
  const p = schema.plugin;
  const others = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx
    .select({ id: p.id })
    .from(p)
    .where(and(eq(p.orgId, row.orgId), eq(p.name, row.name), eq(p.imageDigest, row.imageDigest!), ne(p.id, row.id)))
    .limit(1)));
  return others.length > 0;
}

/**
 * Remove a purged version's image (and its signature and attestations) unless
 * another stored version shares the digest. Never throws: a failure is an
 * `image` orphan.
 */
export async function discardPurgedImage(row: PurgedVersion, userId?: string): Promise<'discarded' | 'kept_shared' | 'failed' | 'none'> {
  if (!row.imageDigest) return 'none';
  const registry = registryInfo();
  const repository = relativeRepository(row.name, row.orgId, registry);
  try {
    if (await digestStillStored(row)) {
      incCounter('plugin_purge_image_discards_total', { outcome: 'kept_shared' });
      logger.info('Purged version\'s image kept: another stored version carries the same digest', { orgId: row.orgId, name: row.name, version: row.version, digest: row.imageDigest });
      return 'kept_shared';
    }
    await discardPluginImage({
      repository: imageRepository(row.name, registry, row.orgId),
      digest: row.imageDigest,
      registry,
      orgId: row.orgId,
      context: { pluginVersion: row.version, reason: 'purged', ...(userId ? { userId } : {}) },
    });
    incCounter('plugin_purge_image_discards_total', { outcome: 'discarded' });
    return 'discarded';
  } catch (err) {
    await recordSourceOrphan({ orgId: row.orgId, kind: 'image', bucket: repository, target: row.imageDigest, pluginId: row.id, pluginVersion: row.version, error: err });
    return 'failed';
  }
}

/**
 * Everything a purge removes outside Postgres, per version (see the module
 * comment). Call AFTER the rows are hard-deleted, with the rows as they were.
 * Never throws.
 */
export async function teardownPurgedVersions(rows: readonly PurgedVersion[], opts: { userId?: string } = {}): Promise<void> {
  for (const row of rows) {
    await deletePluginSourcePrefix({ orgId: row.orgId, pluginId: row.id, version: row.version, prefix: pluginSourceVersionPrefix(row.orgId, row.id, row.version) });
    await discardPurgedImage(row, opts.userId);
  }
}

/**
 * The purge sweep's retry of failed source and image deletes. An image orphan
 * is re-checked for a sharing version first (one may have been uploaded since)
 * and then discarded again; the digest kept for a sharing version clears the
 * orphan, since nothing is left to delete.
 */
export async function retryPurgeOrphans(limit = 100): Promise<{ tried: number; cleared: number; failed: number }> {
  const registry = registryInfo();
  return retryPluginSourceOrphans({
    limit,
    retryImage: async (o) => {
      const name = o.bucket.split('/').slice(1).join('/');
      const shared = await digestStillStored({ id: o.pluginId ?? '00000000-0000-0000-0000-000000000000', orgId: o.orgId, name, version: o.pluginVersion ?? '', imageDigest: o.target });
      if (shared) return;
      await discardPluginImage({ repository: `${registry.host}:${registry.port}/${o.bucket}`, digest: o.target, registry, orgId: o.orgId, context: { reason: 'purged' } });
    },
  });
}
