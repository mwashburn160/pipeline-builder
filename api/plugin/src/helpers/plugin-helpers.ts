// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { normalizeArrayFields, SYSTEM_ORG_ID, type MetadataSources, type Visibility } from '@pipeline-builder/api-core';
import { type ComputeType, type PluginType } from '@pipeline-builder/pipeline-core';
import type { PluginContractValueType, PluginIcon } from '@pipeline-builder/pipeline-data';

import type { BuildRequest, BuildType } from './docker-build.js';
import type { PluginInsert, WriteAccess } from '../services/plugin-service.js';

/** Plugin config parsed from config.yaml in the ZIP root. */
export interface PluginConfig {
  pluginSpec?: string;
  dockerfile?: string;
  buildType?: BuildType;
}

/**
 * Compute the namespace-relative image URI for a plugin:
 *   - system-org plugins → `system/<name>:<version>`
 *   - tenant-org plugins → `org-<orgId>/<name>:<version>`
 *
 * Host/port are deliberately omitted because they vary per environment.
 * Callers prepend the registry host when they need a full pull-able ref.
 */
export function pluginUri(plugin: { orgId: string; name: string; version: string }): string {
  const namespace = plugin.orgId === SYSTEM_ORG_ID ? 'system' : `org-${plugin.orgId}`;
  return `${namespace}/${plugin.name}:${plugin.version}`;
}

/**
 * Whether a plugin row runs on its own image — and so must carry a signed
 * `imageDigest`. Mirrors the worker's skip rules: `metadata_only` builds no
 * image, and a `ManualApprovalStep` never runs one.
 */
export function pluginRequiresImage(plugin: { buildType: string; pluginType: string }): boolean {
  return plugin.buildType !== 'metadata_only' && plugin.pluginType !== 'ManualApprovalStep';
}

/**
 * Shape a Plugin row for HTTP responses: normalize array-typed columns and
 * attach the computed `uri`. Single seam so all read routes return the
 * same shape.
 *
 * Future: a generic `shapeEntity` helper in api-core could replace this once
 * other services need the same pattern.
 */
interface PluginRow {
  orgId: string;
  name: string;
  version: string;
  keywords?: unknown;
  installCommands?: unknown;
  commands?: unknown;
}
const PLUGIN_ARRAY_FIELDS = ['keywords', 'installCommands', 'commands'] as const;
export function shapePlugin<P extends PluginRow>(plugin: P): P & { uri?: string } {
  // normalizeArrayFields requires an index signature; the cast is the single
  // type-system seam between Drizzle's strict row types and the helper's
  // generic Record<string, unknown> contract. A future `shapeEntity` helper
  // in api-core could be re-typed to avoid the cast here.
  const normalized = normalizeArrayFields(
    plugin as unknown as Record<string, unknown>,
    [...PLUGIN_ARRAY_FIELDS],
  ) as unknown as P;
  // A sparse-fieldset list row (`?fields=`) may omit the columns the URI is
  // derived from; omit `uri` then rather than emit "org-undefined/…:undefined".
  const hasUriParts = [plugin.orgId, plugin.name, plugin.version].every((v) => typeof v === 'string' && v !== '');
  return hasUriParts ? { ...normalized, uri: pluginUri(plugin) } : normalized;
}

// Build job types & factory

/** Plugin record data stored in the BullMQ job for DB insertion. */
export interface PluginRecordData extends PluginDocFields {
  /**
   * ISO `resetAt` of the quota period the upload's `plugins` slot was charged
   * to (the `quota_reset_at` column). A string, not a Date: the record rides a
   * BullMQ job as JSON. {@link toPluginInsert} converts it.
   */
  quotaResetAt?: string | null;
  orgId: string;
  name: string;
  description: string | null;
  version: string;
  category: string;
  metadata: Record<string, string | number | boolean>;
  pluginType: PluginType;
  computeType: ComputeType;
  primaryOutputDirectory: string | null;
  dockerfile: string | null;
  env: Record<string, string>;
  buildArgs: Record<string, string>;
  keywords: string[];
  installCommands: string[];
  commands: string[];
  visibility: Visibility;
  timeout: number | null;
  failureBehavior: 'fail' | 'warn' | 'ignore';
  buildType: BuildType;
  secrets: Array<{ name: string; required: boolean; description?: string }>;
}

/**
 * The spec's execution-contract fields persisted with every version:
 * validated at upload, stored verbatim, never editable. Built by
 * `specContractFields` (plugin-spec.ts).
 */
export interface PluginContractFields {
  requiredMetadata: string[];
  requiredVars: string[];
  metadataTypes: Record<string, PluginContractValueType>;
  varsTypes: Record<string, PluginContractValueType>;
  smokeTest: string | null;
  networkEgress: string[];
}

/**
 * The descriptive catalog columns other than description / category /
 * keywords (which sit on the record itself): detected from the package, then
 * accepted or edited. Built by `catalogColumns` (catalog-metadata.ts).
 */
export interface PluginCatalogDocFields {
  summary: string | null;
  displayName: string | null;
  readmeMd: string | null;
  /** `readmeMd` rendered once, server-side, to sanitized HTML (the only form served). */
  readmeHtml: string | null;
  license: string | null;
  changelog: string | null;
  homepageUrl: string | null;
  sourceUrl: string | null;
  documentationUrl: string | null;
  icon: PluginIcon | null;
  /** Per-field provenance (`spec | readme | dockerfile | derived | user`). */
  metadataSources: MetadataSources;
}

/**
 * Everything persisted with a version beyond its run config: the contract plus
 * the catalog documentation. Plain data so it survives the BullMQ trip to the
 * build worker.
 */
export interface PluginDocFields extends PluginContractFields, PluginCatalogDocFields {}

/** Failure classification for DLQ routing. */
export type FailureCategory = 'retryable' | 'permanent';

/** Data stored in each BullMQ job. */
export interface PluginBuildJobData {
  requestId: string;
  orgId: string;
  userId: string;
  /** The uploader's visibility-ladder authority, snapshotted at upload time so
   *  the worker's `deployVersion` applies the same overwrite gate the route did. */
  access: WriteAccess;
  buildRequest: BuildRequest;
  pluginRecord: PluginRecordData;
  failureCategory?: FailureCategory;
  lastError?: string;
  /** Total attempts across main queue + DLQ cycles. Prevents infinite retry loops. */
  totalAttempts?: number;
  /**
   * Set once the reserved plugins quota slot has been released for this job, so a
   * later DLQ purge (enforceDlqMaxSize / purgeDlq) doesn't decrement it again
   * (double-count) and an un-released job purged early still gets its slot back.
   */
  quotaReleased?: boolean;
  /**
   * ISO `resetAt` of the quota period this job's slot was reserved in (captured
   * at route reserve time, or at re-reserve time for a DLQ replay / failed
   * retry). Passed as the conditional-decrement snapshot when the slot is later
   * released (`releasePluginQuota`): a DLQ retry can span a quota-period reset,
   * and without the snapshot the refund would land on the NEW period (stealing
   * capacity). When the stored `resetAt` no longer matches, the decrement is a
   * no-op — the old period already reset to 0, so there is nothing to refund.
   */
  reservedResetAt?: string;
  /**
   * Set when the upload asked for a publish request (`publishRequest=true`,
   * ): once the version is deployed the worker submits a
   * new-listing / new-version request AS this caller (snapshotted at upload).
   */
  publish?: { caller: PublishCaller };
}

/** The uploader, snapshotted for the post-build publish request (see `services/ecosystem/context.ts` `Caller`). */
export interface PublishCaller {
  userId: string;
  orgId: string;
  parentOrgId?: string;
  principalType: string;
  name?: string;
  isSuperAdmin: boolean;
  permissions: readonly string[];
  features: readonly string[];
}

/** Parameters for creating a plugin build job. */
interface CreateBuildJobParams {
  requestId: string;
  orgId: string;
  userId: string;
  access: WriteAccess;
  buildRequest: BuildRequest;
  pluginRecord: Partial<PluginRecordData> & Pick<PluginRecordData, 'orgId' | 'name' | 'version' | 'commands' | 'visibility'>;
  /** ISO `resetAt` observed when the plugins slot was reserved (see
   *  {@link PluginBuildJobData.reservedResetAt}). Threaded through so the
   *  terminal-failure refund is period-safe. */
  reservedResetAt?: string;
  /** Submit a publish request after the build (see {@link PluginBuildJobData.publish}). */
  publish?: { caller: PublishCaller };
}

/** A version that declares no contract and ships no documentation. */
export const EMPTY_DOC_FIELDS: PluginDocFields = {
  requiredMetadata: [],
  requiredVars: [],
  metadataTypes: {},
  varsTypes: {},
  smokeTest: null,
  networkEgress: [],
  summary: null,
  displayName: null,
  readmeMd: null,
  readmeHtml: null,
  license: null,
  changelog: null,
  homepageUrl: null,
  sourceUrl: null,
  documentationUrl: null,
  icon: null,
  metadataSources: {},
};

/** Create a PluginBuildJobData with defaults applied. */
export function createBuildJobData(params: CreateBuildJobParams): PluginBuildJobData {
  const { pluginRecord, ...envelope } = params;
  return {
    ...envelope,
    pluginRecord: {
      description: null,
      category: 'unknown',
      metadata: {},
      pluginType: 'CodeBuildStep',
      computeType: 'SMALL',
      primaryOutputDirectory: null,
      dockerfile: null,
      env: {},
      buildArgs: {},
      keywords: [],
      installCommands: [],
      timeout: null,
      failureBehavior: 'fail',
      buildType: 'build_image',
      secrets: [],
      ...EMPTY_DOC_FIELDS,
      ...pluginRecord,
    },
  };
}

/**
 * A job/route plugin record as the row `deployVersion` writes: the JSON-safe
 * quota snapshot becomes a Date, and `extra` (the worker's image + scan facts)
 * is layered on top.
 */
export function toPluginInsert(record: PluginRecordData, extra: Partial<PluginInsert> = {}): PluginInsert {
  const { quotaResetAt, ...rest } = record;
  return {
    ...rest,
    quotaResetAt: quotaResetAt ? new Date(quotaResetAt) : null,
    ...extra,
  };
}
