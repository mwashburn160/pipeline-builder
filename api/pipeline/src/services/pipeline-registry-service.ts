// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  BUILD_IMAGE_MANIFEST_ACTION, BUILD_IMAGE_MANIFEST_STAGE, BUILD_IMAGE_STEP_KEY, createLogger, errorMessage, isSystemOrgId, scrubAwsIdentifiersFromString,
} from '@pipeline-builder/api-core';
import { pluginImageRepository, type StepManifestEntry, type ToolchainResolvedVia } from '@pipeline-builder/pipeline-core';
import {
  closePipelineExposures, drizzleListingSource, installModeFor, listingBlock, loadOrgInstallContext, reconcilePipelineExposures, runWithTenantContext, schema, withTenantTx,
  type ExposureStep, type ScanState,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

const logger = createLogger('pipeline-registry');

export const PR_PIPELINE_NOT_OWNED = 'PR_PIPELINE_NOT_OWNED';
export const PR_REGISTRY_OWNED_BY_OTHER_ORG = 'PR_REGISTRY_OWNED_BY_OTHER_ORG';

export interface RegistryUpsertInput {
  pipelineId: string;
  orgId: string;
  pipelineName: string;
  region?: string;
  project?: string;
  organization?: string;
  stackName?: string;
  /**
   * The synth's step manifest. When present, the pipeline's stored
   * manifest is REPLACED with it in the same tx as the registry upsert; when
   * absent (a manual register), the stored manifest is left as is.
   */
  steps?: Array<StepManifestEntry & { resolvedVia?: ToolchainResolvedVia }>;
  /** The caller's parent (root) org when it is a team: its installs apply. */
  parentOrgId?: string;
}

type Tx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/** The managed toolchain's build-image half — the only plugin a build-image entry may name. */
const BOOTSTRAP_PLUGIN = 'pipeline-bootstrap';

/** What a manifest row records about a step's plugin. */
interface ManifestPlugin {
  publisher: string | null;
  /** The listing publisher's id — what the cross-org plugin stats join on (a handle can change). */
  publisherId: string | null;
  name: string;
  version: string;
  imageDigest: string | null;
  imageRepository: string | null;
  /** The record's stored scan state — what the deployed-side exposure is opened from. */
  scan: ScanState;
  /** The owning org of an org plugin row (null for a listing version). */
  ownerOrgId?: string | null;
}

/**
 * The LISTED versions among `ids` that the org actually reaches (see
 * docs/plugin-installing.md): a listing version the synth resolved through an install —
 * explicit (the org's own, or its root org's for a team) or the implicit
 * Official one — and that the org's policy doesn't block. Attributed to the
 * listing's publisher, with its `public/*` repository. Read ELEVATED (the
 * ecosystem tables, and a team's root-org install rows), scoped by the
 * explicit org ids; everything else about the entry is the caller's own.
 */
async function listedStepPlugins(ids: string[], orgId: string, parentOrgId?: string): Promise<Map<string, ManifestPlugin>> {
  const out = new Map<string, ManifestPlugin>();
  if (ids.length === 0) return out;
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(async (tx) => {
    const V = schema.pluginListingVersion;
    const versions = await tx
      .select({
        id: V.id,
        listingId: V.listingId,
        version: V.version,
        imageDigest: V.imageDigest,
        imageRepository: V.imageRepository,
        scanSummary: V.scanSummary,
        scanFlag: V.scanFlag,
        scanFlaggedAt: V.scanFlaggedAt,
      })
      .from(V)
      .where(inArray(V.id, ids));
    if (versions.length === 0) return out;
    const source = drizzleListingSource(tx);
    const scope = { orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) };
    const listings = await source.liveListings({ ids: [...new Set(versions.map((v) => v.listingId))] });
    const publishers = await source.publishersByIds([...new Set(listings.map((l) => l.publisherId))]);
    const ctx = await loadOrgInstallContext(source, scope);
    for (const v of versions) {
      const listing = listings.find((l) => l.id === v.listingId);
      const publisher = listing ? publishers.find((p) => p.id === listing.publisherId) : undefined;
      if (!listing || !publisher || listingBlock(ctx.policy, publisher, listing)) continue;
      if ('code' in installModeFor(publisher, listing, ctx.installs, ctx.policy, scope)) continue;
      out.set(v.id, {
        publisher: publisher.handle,
        publisherId: publisher.id,
        name: listing.name,
        version: v.version,
        imageDigest: v.imageDigest,
        imageRepository: v.imageRepository,
        scan: { imageDigest: v.imageDigest, scanSummary: v.scanSummary, scanFlag: v.scanFlag, scanFlaggedAt: v.scanFlaggedAt },
      });
    }
    return out;
  }));
}

/**
 * Replace a pipeline's step manifest. The CLI's entries are trusted only for
 * the pipeline's own shape (stage/action names — it can only mislabel its own
 * pipeline); everything that feeds cross-org stats and verified use comes from
 * the record the entry's `pluginId` names: the caller's own `plugins` row (read
 * under its RLS scope — own org; no publisher), or a listing version it reaches
 * through an install (`listed`, attributed to the listing's publisher). An
 * entry naming anything else is dropped, so an org can't attribute its runs to
 * someone else's plugin.
 *
 * The BUILD-IMAGE entry (the sentinel (stage, action), docs/plans/
 * bootstrap-image-versioning.md §4) is kept only when it names the system
 * org's `pipeline-bootstrap`: its `plugin_version` is the release the pipeline
 * runs. Against the row it replaces, a different release records the change
 * (`previous_release_version`, `release_changed_at`: the run-history marker);
 * the same release carries the last change forward.
 */
async function replaceStepManifest(
  tx: Tx, pipelineId: string, orgId: string, steps: NonNullable<RegistryUpsertInput['steps']>, listed: Map<string, ManifestPlugin>,
): Promise<{ count: number; plugins: ManifestPlugin[] }> {
  const M = schema.pipelineStepManifest;
  const [priorBuildImage] = await tx
    .select({ version: M.pluginVersion, previous: M.previousReleaseVersion, changedAt: M.releaseChangedAt })
    .from(M)
    .where(and(eq(M.pipelineId, pipelineId), eq(M.stageName, BUILD_IMAGE_MANIFEST_STAGE), eq(M.actionName, BUILD_IMAGE_MANIFEST_ACTION)));
  await tx.delete(schema.pipelineStepManifest).where(eq(schema.pipelineStepManifest.pipelineId, pipelineId));
  if (steps.length === 0) return { count: 0, plugins: [] };

  const pluginIds = [...new Set(steps.map((s) => s.pluginId))].filter((id) => !listed.has(id));
  const rows = pluginIds.length === 0 ? [] : await tx
    .select({
      id: schema.plugin.id,
      orgId: schema.plugin.orgId,
      name: schema.plugin.name,
      version: schema.plugin.version,
      imageDigest: schema.plugin.imageDigest,
      buildType: schema.plugin.buildType,
      scanSummary: schema.plugin.scanSummary,
      scanFlag: schema.plugin.scanFlag,
      scanFlaggedAt: schema.plugin.scanFlaggedAt,
    })
    .from(schema.plugin)
    .where(inArray(schema.plugin.id, pluginIds));
  const byId = new Map<string, ManifestPlugin>(listed);
  for (const p of rows) {
    byId.set(p.id, {
      publisher: null,
      publisherId: null,
      name: p.name,
      version: p.version,
      imageDigest: p.imageDigest,
      imageRepository: p.imageDigest ? pluginImageRepository(p) : null,
      scan: { imageDigest: p.imageDigest, scanSummary: p.scanSummary, scanFlag: p.scanFlag, scanFlaggedAt: p.scanFlaggedAt },
      ownerOrgId: p.orgId,
    });
  }

  // Keyed on the PK so a duplicated (stage, action) can't fail the insert.
  // Names are scrubbed exactly as event ingest scrubs the event's names, so
  // the ingest join compares like with like.
  const manifest = new Map<string, typeof schema.pipelineStepManifest.$inferInsert>();
  const recorded: ManifestPlugin[] = [];
  const updatedAt = new Date();
  for (const step of steps) {
    const plugin = byId.get(step.pluginId);
    if (!plugin) continue;
    const buildImage = step.stageName === BUILD_IMAGE_MANIFEST_STAGE && step.actionName === BUILD_IMAGE_MANIFEST_ACTION;
    if (buildImage && !(plugin.publisher === null && plugin.name === BOOTSTRAP_PLUGIN && isSystemOrgId(plugin.ownerOrgId ?? ''))) continue;
    recorded.push(plugin);
    const stageName = scrubAwsIdentifiersFromString(step.stageName);
    const actionName = scrubAwsIdentifiersFromString(step.actionName);
    // The `build-image` key belongs to the build-image row alone.
    const stepKey = buildImage
      ? BUILD_IMAGE_STEP_KEY
      : typeof step.stepKey === 'string' && step.stepKey && step.stepKey !== BUILD_IMAGE_STEP_KEY ? step.stepKey.slice(0, 255) : null;
    const change = !buildImage ? null
      : priorBuildImage && priorBuildImage.version !== plugin.version
        ? { previousReleaseVersion: priorBuildImage.version, releaseChangedAt: updatedAt }
        : { previousReleaseVersion: priorBuildImage?.previous ?? null, releaseChangedAt: priorBuildImage?.changedAt ?? null };
    manifest.set(`${stageName}\u0000${actionName}`, {
      pipelineId,
      orgId,
      stageName,
      actionName,
      pluginPublisher: plugin.publisher,
      pluginPublisherId: plugin.publisherId,
      pluginName: plugin.name,
      pluginVersion: plugin.version,
      imageDigest: plugin.imageDigest,
      imageRepository: plugin.imageRepository,
      stepKey,
      ...(buildImage ? { resolvedVia: step.resolvedVia ?? null, ...change } : {}),
      updatedAt,
    });
  }
  if (manifest.size > 0) await tx.insert(schema.pipelineStepManifest).values([...manifest.values()]);
  return { count: manifest.size, plugins: recorded };
}

class PipelineRegistryService {
  /** Paginated list of registry rows for an org. */
  async list(orgId: string, limit: number, offset: number) {
    return withTenantTx(async (tx) => {
      const countQuery = tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.pipelineRegistry)
        .where(eq(schema.pipelineRegistry.orgId, orgId));

      const rowsQuery = tx
        .select()
        .from(schema.pipelineRegistry)
        .where(eq(schema.pipelineRegistry.orgId, orgId))
        .orderBy(desc(schema.pipelineRegistry.lastDeployed))
        .limit(limit)
        .offset(offset);

      const [countResult, rows] = await Promise.all([countQuery, rowsQuery]);
      return { rows, total: countResult[0]?.count ?? 0 };
    });
  }

  /**
   * Upsert a registry row by pipelineId (the stable key the events Lambda
   * resolves from the `pb.pipeline-id` tag). Enforces two tenancy guards:
   *   1. The caller's org must own `pipelineId` (prevents claiming other orgs'
   *      pipeline IDs).
   *   2. Any existing registry row for `pipelineId` must belong to the caller's
   *      org (defense in depth against a re-bind under a withdrawn pipeline).
   * Throws PR_PIPELINE_NOT_OWNED or PR_REGISTRY_OWNED_BY_OTHER_ORG.
   *
   * `exposures` counts the deployed-side exposures the manifest reconcile opened
   * and closed (absent when no manifest was sent, so nothing was reconciled) —
   * for the caller's audit event, not the response.
   */
  async upsert(input: RegistryUpsertInput) {
    const { pipelineId, orgId, pipelineName, region, project, organization, stackName, steps, parentOrgId } = input;
    // Listed versions the steps name, resolved (elevated, read-only) BEFORE the
    // tenant transaction below.
    const listed = steps ? await listedStepPlugins([...new Set(steps.map((s) => s.pluginId))], orgId, parentOrgId) : new Map<string, ManifestPlugin>();

    // All operations run in one tx so an attacker can't race the gate checks
    // against the insert under a withdrawn pipeline binding.
    let deployed: ManifestPlugin[] | undefined;
    const registered = await withTenantTx(async (tx) => {
      // A SOFT-DELETED pipeline still registers: deleting the config does not
      // stop the CodePipeline it deployed, and its events, manifest and deployed
      // exposures must keep tracking what actually runs. The registration says
      // so (`pipelineDeleted`), so a caller can tell the stack outlived its config.
      // A PURGED one has no row, and is refused below.
      const [pipeline] = await tx
        .select({ id: schema.pipeline.id, deletedAt: schema.pipeline.deletedAt })
        .from(schema.pipeline)
        .where(and(
          eq(schema.pipeline.id, pipelineId),
          eq(schema.pipeline.orgId, orgId),
        ));
      if (!pipeline) throw new Error(PR_PIPELINE_NOT_OWNED);
      const pipelineDeleted = pipeline.deletedAt !== null && pipeline.deletedAt !== undefined;

      const [existing] = await tx
        .select({ orgId: schema.pipelineRegistry.orgId })
        .from(schema.pipelineRegistry)
        .where(eq(schema.pipelineRegistry.pipelineId, pipelineId));
      if (existing && existing.orgId !== orgId) throw new Error(PR_REGISTRY_OWNED_BY_OTHER_ORG);

      const now = new Date();
      const [result] = await tx
        .insert(schema.pipelineRegistry)
        .values({
          pipelineId,
          orgId,
          pipelineName,
          region,
          project,
          organization,
          stackName,
          lastDeployed: now,
        })
        .onConflictDoUpdate({
          target: schema.pipelineRegistry.pipelineId,
          // Only overwrite an optional column when the re-register actually
          // provides a value. A partial re-register that omits `region` (or the
          // other optionals) must NOT null out the stored value — execution
          // routing resolves the CodePipeline region from this row, so a NULL
          // here would break trigger/cancel. COALESCE(excluded.col, table.col)
          // keeps the existing value when the incoming one is NULL.
          set: {
            pipelineName,
            region: sql`COALESCE(excluded.region, ${schema.pipelineRegistry.region})`,
            project: sql`COALESCE(excluded.project, ${schema.pipelineRegistry.project})`,
            organization: sql`COALESCE(excluded.organization, ${schema.pipelineRegistry.organization})`,
            stackName: sql`COALESCE(excluded.stack_name, ${schema.pipelineRegistry.stackName})`,
            lastDeployed: now,
            updatedAt: now,
          },
        })
        .returning();
      const replaced = steps ? await replaceStepManifest(tx, pipelineId, orgId, steps, listed) : undefined;
      deployed = replaced?.plugins;
      const manifestSteps = replaced?.count;
      return { ...result, ...(manifestSteps !== undefined ? { manifestSteps } : {}), ...(pipelineDeleted ? { pipelineDeleted: true as const } : {}) };
    });

    // The DEPLOYED side of exposure tracking, after the manifest committed: open
    // an exposure for every step whose version has open fixable findings, close
    // the ones this deploy moved off. Never throws (reporting must not fail a
    // registration); a manual register without a manifest leaves them as they are.
    let exposures: { opened: number; closed: number } | undefined;
    if (deployed) {
      exposures = await reconcilePipelineExposures({
        orgId,
        pipelineId,
        source: 'deployed',
        steps: deployed.map((p): ExposureStep => ({
          pluginPublisher: p.publisher, pluginName: p.name, pluginVersion: p.version, imageDigest: p.imageDigest, scan: p.scan,
        })),
      });
    }
    return { ...registered, exposures };
  }

  /**
   * Resolve a pipelineId to its CodePipeline physical name + region, scoped to
   * the caller's org. Returns null when no registry row exists for the pipeline
   * in the caller's org (a pipelineId owned by another org resolves to null —
   * the org filter is part of the WHERE, so a cross-org id is indistinguishable
   * from an absent one). This is the lookup the trigger/cancel write path uses
   * to address the live CodePipeline directly.
   */
  async findByPipelineId(
    pipelineId: string,
    orgId: string,
  ): Promise<{ pipelineName: string; region: string; stackName?: string } | null> {
    return withTenantTx(async (tx) => {
      const [row] = await tx
        .select({
          pipelineName: schema.pipelineRegistry.pipelineName,
          region: schema.pipelineRegistry.region,
          stackName: schema.pipelineRegistry.stackName,
        })
        .from(schema.pipelineRegistry)
        .where(and(
          eq(schema.pipelineRegistry.pipelineId, pipelineId),
          eq(schema.pipelineRegistry.orgId, orgId),
        ));
      if (!row) return null;
      return {
        pipelineName: row.pipelineName,
        region: row.region ?? '',
        stackName: row.stackName ?? undefined,
      };
    });
  }

  /**
   * Whether this pipeline has a deploy REGISTRATION, plus when it last deployed.
   *
   * Exists so the pipeline page can explain an empty report. Event ingest resolves
   * every event through the registry, so a pipeline with no registry row produces
   * no events at all — its reports, DORA metrics and execution history are
   * legitimately blank, which is indistinguishable from "nothing has run" unless
   * the UI says so. Common cause: deployed, but the post-deploy registration call
   * hasn't landed (or was never run).
   */
  async findRegistrationStatus(
    pipelineId: string,
    orgId: string,
  ): Promise<{ registered: boolean; lastDeployed: string | null; stackName: string | null; region: string | null }> {
    return withTenantTx(async (tx) => {
      const [row] = await tx
        .select({
          lastDeployed: schema.pipelineRegistry.lastDeployed,
          stackName: schema.pipelineRegistry.stackName,
          region: schema.pipelineRegistry.region,
        })
        .from(schema.pipelineRegistry)
        .where(and(
          eq(schema.pipelineRegistry.pipelineId, pipelineId),
          eq(schema.pipelineRegistry.orgId, orgId),
        ));
      if (!row) return { registered: false, lastDeployed: null, stackName: null, region: null };
      return {
        registered: true,
        lastDeployed: row.lastDeployed ? row.lastDeployed.toISOString() : null,
        stackName: row.stackName ?? null,
        region: row.region ?? null,
      };
    });
  }

  /**
   * Whether ANY org has a registration for `pipelineId` — the "a stack may still
   * be running" signal a purge checks. Elevated, by pipeline id alone: a
   * sysadmin purge runs with no org of its own, and the registry is the only
   * record of a deployment the platform has.
   */
  async deploymentOf(pipelineId: string): Promise<{ registryId: string; stackName: string | null; region: string | null } | null> {
    return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(async (tx) => {
      const [row] = await tx
        .select({ registryId: schema.pipelineRegistry.id, stackName: schema.pipelineRegistry.stackName, region: schema.pipelineRegistry.region })
        .from(schema.pipelineRegistry)
        .where(eq(schema.pipelineRegistry.pipelineId, pipelineId))
        .limit(1);
      return row ? { registryId: row.registryId, stackName: row.stackName ?? null, region: row.region ?? null } : null;
    }));
  }

  /**
   * Hard-delete a registry row scoped to the caller's org, and the pipeline's
   * step manifest with it — a deregistered pipeline no longer runs, and a
   * leftover manifest would keep its image digests "referenced" for the
   * `public/*` GC guard forever. Its DEPLOYED exposures close as `removed`
   * after the commit (best-effort, like the reconcile). Returns the deleted row
   * plus how many exposures that closed (0 when the close failed), or null.
   */
  async delete(id: string, orgId: string) {
    const deleted = await withTenantTx(async (tx) => {
      const [row] = await tx
        .delete(schema.pipelineRegistry)
        .where(and(
          eq(schema.pipelineRegistry.id, id),
          eq(schema.pipelineRegistry.orgId, orgId),
        ))
        .returning({
          id: schema.pipelineRegistry.id,
          pipelineId: schema.pipelineRegistry.pipelineId,
        });
      if (!row) return null;
      await tx.delete(schema.pipelineStepManifest).where(and(
        eq(schema.pipelineStepManifest.pipelineId, row.pipelineId),
        eq(schema.pipelineStepManifest.orgId, orgId),
      ));
      return row;
    });
    if (!deleted) return null;
    let exposuresClosed = 0;
    try {
      exposuresClosed = await closePipelineExposures(deleted.pipelineId, 'removed', { source: 'deployed' });
    } catch (err) {
      logger.warn('Deployed exposures of a deregistered pipeline not closed', { pipelineId: deleted.pipelineId, error: errorMessage(err) });
    }
    return { ...deleted, exposuresClosed };
  }
}

export const pipelineRegistryService = new PipelineRegistryService();
