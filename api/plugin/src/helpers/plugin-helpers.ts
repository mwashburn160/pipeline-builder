// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { normalizeArrayFields, SYSTEM_ORG_ID, type AccessModifier } from '@pipeline-builder/api-core';
import { type ComputeType, type PluginType } from '@pipeline-builder/pipeline-core';

import type { BuildRequest, BuildType } from './docker-build';

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
 * Shape a Plugin row for HTTP responses: normalize array-typed columns and
 * attach the computed `uri`. Single seam so all read routes return the
 * same shape.
 */
const PLUGIN_ARRAY_FIELDS = ['keywords', 'installCommands', 'commands'] as const;
export function shapePlugin<T extends { orgId: string; name: string; version: string }>(plugin: T): T & { uri: string } {
  return {
    ...normalizeArrayFields(plugin as unknown as Record<string, unknown>, PLUGIN_ARRAY_FIELDS as unknown as string[]) as unknown as T,
    uri: pluginUri(plugin),
  };
}

// Build job types & factory

/** Plugin record data stored in the BullMQ job for DB insertion. */
export interface PluginRecordData {
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
  accessModifier: AccessModifier;
  timeout: number | null;
  failureBehavior: 'fail' | 'warn' | 'ignore';
  buildType: BuildType;
  secrets: Array<{ name: string; required: boolean; description?: string }>;
}

/** Failure classification for DLQ routing. */
export type FailureCategory = 'retryable' | 'permanent';

/** Data stored in each BullMQ job. */
export interface PluginBuildJobData {
  requestId: string;
  orgId: string;
  userId: string;
  buildRequest: BuildRequest;
  pluginRecord: PluginRecordData;
  failureCategory?: FailureCategory;
  lastError?: string;
  /** Total attempts across main queue + DLQ cycles. Prevents infinite retry loops. */
  totalAttempts?: number;
}

/** Parameters for creating a plugin build job. */
interface CreateBuildJobParams {
  requestId: string;
  orgId: string;
  userId: string;
  buildRequest: BuildRequest;
  pluginRecord: Partial<PluginRecordData> & Pick<PluginRecordData, 'orgId' | 'name' | 'version' | 'commands' | 'accessModifier'>;
}

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
      ...pluginRecord,
    },
  };
}
