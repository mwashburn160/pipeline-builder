import { CoreConstants } from '@mwashburn160/pipeline-core';
import { v7 as uuid } from 'uuid';

import type { BuildRequest, BuildType } from './docker-build';

/** Plugin config parsed from config.yaml in the ZIP root. */
export interface PluginConfig {
  spec?: string;
  dockerfile?: string;
  buildType?: BuildType;
  imageTar?: string;
}

// Image tag generation

const IMAGE_TAG_PREFIX = CoreConstants.PLUGIN_IMAGE_PREFIX;

/** Generate a unique, lowercase image tag for a plugin. */
export function generateImageTag(name: string): string {
  return `${IMAGE_TAG_PREFIX}${name.replace(/[^a-z0-9]/gi, '')}-${uuid().slice(0, 8)}`.toLowerCase();
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
  pluginType: string;
  computeType: string;
  primaryOutputDirectory: string | null;
  dockerfile: string | null;
  env: Record<string, string>;
  buildArgs: Record<string, string>;
  keywords: string[];
  installCommands: string[];
  commands: string[];
  imageTag: string;
  accessModifier: string;
  timeout: number | null;
  failureBehavior: string;
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
  authToken: string;
  buildRequest: BuildRequest;
  pluginRecord: PluginRecordData;
  failureCategory?: FailureCategory;
  lastError?: string;
  /** Total attempts across main queue + DLQ cycles. Prevents infinite retry loops. */
  totalAttempts?: number;
}

/** Parameters for creating a plugin build job. */
export interface CreateBuildJobParams {
  requestId: string;
  orgId: string;
  userId: string;
  authToken: string;
  buildRequest: BuildRequest;
  pluginRecord: Partial<PluginRecordData> & Pick<PluginRecordData, 'orgId' | 'name' | 'version' | 'commands' | 'imageTag' | 'accessModifier'>;
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
