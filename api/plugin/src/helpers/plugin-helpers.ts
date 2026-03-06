import { CoreConstants } from '@mwashburn160/pipeline-core';
import { v7 as uuid } from 'uuid';

import type { BuildRequest } from './docker-build';

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
  secrets: Array<{ name: string; required: boolean; description?: string }>;
}

/** Data stored in each BullMQ job. */
export interface PluginBuildJobData {
  requestId: string;
  orgId: string;
  userId: string;
  authToken: string;
  buildRequest: BuildRequest;
  pluginRecord: PluginRecordData;
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
      secrets: [],
      ...pluginRecord,
    },
  };
}
