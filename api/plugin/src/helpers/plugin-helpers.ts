import {
  normalizeArrayFields,
  sendEntityNotFound,
  validateQuery,
  PluginFilterSchema,
  type ValidatedPluginFilter,
  type ValidationResult,
} from '@mwashburn160/api-core';
import { CoreConstants } from '@mwashburn160/pipeline-core';
import { Request, Response } from 'express';
import { v7 as uuid } from 'uuid';

import type { BuildRequest } from './docker-build';

// Record normalization

/**
 * Normalize a plugin record from the database before returning to clients.
 * Ensures jsonb array fields are always arrays (guards against bad data).
 */
export function normalizePlugin<T extends Record<string, unknown>>(record: T): T {
  return normalizeArrayFields(record, ['keywords', 'installCommands', 'commands']);
}

// Filter validation (Zod-based)

/**
 * Validate plugin filter params from query string using Zod schema.
 * Provides runtime type-safe validation with automatic type coercion.
 *
 * @param req - Express request with query parameters
 * @returns Validation result with parsed filter or error message
 */
export function validateFilter(req: Request): ValidationResult<ValidatedPluginFilter> {
  return validateQuery(req, PluginFilterSchema);
}

// Error helpers

/** Send a 404 "plugin not found" response. */
export function sendPluginNotFound(res: Response): void {
  sendEntityNotFound(res, 'Plugin');
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
