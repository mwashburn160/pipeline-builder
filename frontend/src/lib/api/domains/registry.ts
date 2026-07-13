// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import { ApiError, toRegistryError } from '../errors';
import type { ApiResponse, RegistryRepository, RegistryTagList, RegistryManifest, RegistryCopyResult } from '@/types';

export function registryApi(core: ApiCore) {
  return {
    // ==========================================================================
    // Image Registry (sysadmin-only; consumed by /dashboard/registry)
    // ==========================================================================

    /**
     * List repositories from /v2/_catalog with cursor pagination.
     * Pass `nonEmpty: true` to have the backend drop repos with no tags
     * (empty shells left behind after all tags are deleted).
     */
    listImages: async (params?: { limit?: number; last?: string; nonEmpty?: boolean }) => {
      return core.request<ApiResponse<{ repositories: RegistryRepository[]; next?: string }>>(
        `/api/images${buildQuery(params as Record<string, unknown> | undefined)}`,
      );
    },

    /** List all tags for one repository. `tags` may be null when the repo is empty. */
    listImageTags: async (name: string) => {
      return core.request<ApiResponse<RegistryTagList>>(
        `/api/images/${encodeURIComponent(name)}/tags`,
      );
    },

    /** Fetch the manifest body + digest for `<name>:<reference>`. */
    getImageManifest: async (name: string, reference: string) => {
      return core.request<ApiResponse<RegistryManifest>>(
        `/api/images/${encodeURIComponent(name)}/manifests/${encodeURIComponent(reference)}`,
      );
    },

    /**
     * Fetch a config blob (≤ 5 MB). Use to power the manifest summary tab.
     * @throws {ApiError} with `statusCode === 413` when the blob exceeds the 5 MB cap,
     *   or other 4xx/5xx codes as-is. Callers branch on `statusCode`.
     */
    getImageBlob: async (name: string, digest: string): Promise<unknown> => {
      const endpoint = `/api/images/${encodeURIComponent(name)}/blobs/${encodeURIComponent(digest)}`;
      try {
        // request() handles proactive refresh, 401-retry-after-refresh, and timeout —
        // blob endpoints inherit those guarantees instead of forking the auth plumbing.
        return await core.request<unknown>(endpoint);
      } catch (err) {
        if (err instanceof ApiError) {
          throw toRegistryError(err.message, err.statusCode, err.code, err.details);
        }
        throw err;
      }
    },

    /** Delete the manifest pointed to by `<name>:<reference>` (resolves to digest, then deletes). */
    deleteImageManifest: async (name: string, reference: string) => {
      return core.request<ApiResponse<{ name: string; digest: string; deleted: true }>>(
        `/api/images/${encodeURIComponent(name)}/manifests/${encodeURIComponent(reference)}`,
        { method: 'DELETE' },
      );
    },

    /**
     * Delete an entire repository — removes every tag/manifest so the repo drops
     * out of `_catalog`. Idempotent: an already-empty repo returns
     * `alreadyEmpty: true`. Used by the registry UI to prune empty repos.
     */
    deleteRepository: async (name: string) => {
      return core.request<ApiResponse<{
        name: string;
        deletedManifests: number;
        deletedTags: number;
        alreadyEmpty?: boolean;
      }>>(
        `/api/images/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
    },

    /**
     * Cross-repo tag copy. Source/target are `<repo>:<ref>` strings.
     * @throws {ConflictError} on 409 (`target-exists` / `source-incomplete`)
     *   or on 400 `source-equals-target`.
     * @throws {ApiError} for other 4xx/5xx.
     */
    copyImage: async (body: {
      source: string;
      target: string;
      overwrite?: boolean;
    }) => {
      try {
        return await core.request<ApiResponse<RegistryCopyResult>>(
          '/api/images/copy',
          { method: 'POST', body: JSON.stringify(body) },
        );
      } catch (err) {
        if (err instanceof ApiError) {
          throw toRegistryError(err.message, err.statusCode, err.code, err.details);
        }
        throw err;
      }
    },

    /**
     * Run application-level registry GC — prunes manifests older than
     * `maxAgeDays` (default 30 server-side) under one repo namespace `prefix`.
     * Maps to POST /api/admin/gc (system-admin only; 403 otherwise). Pass
     * `dryRun: true` to walk + count candidates without issuing any DELETEs.
     */
    runRegistryGc: async (body: { prefix: string; maxAgeDays?: number; dryRun?: boolean }) => {
      return core.request<ApiResponse<{
        reposScanned: number;
        candidates: number;
        deleted: number;
        perRepo: Array<{ repo: string; scanned: number; deleted: number }>;
      }>>('/api/admin/gc', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}
