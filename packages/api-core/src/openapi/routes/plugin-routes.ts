// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registry } from '../registry.js';

const tags = ['Plugins'];
const auth = [{ bearerAuth: [] }];

const publicTags = ['Public plugin directory'];

export function registerPluginRoutes(): void {
  // -- Anonymous public directory (plugin-ecosystem §6a). No auth; nginx serves
  //    these at /api/public/* with credentials stripped. Off → every route 404s.
  registry.registerPath({
    method: 'get',
    path: '/public/plugins',
    summary: 'Search the public plugin directory',
    description: 'Anonymous search and browse over publicly listed plugins, with facets. Query: `q` (full text + '
      + 'typo-tolerant name match), `category`, `tier` (official | verified | community | unverified), `license`, '
      + '`computeType`, `needsSecrets` (true | false), `minRating` (1-5), `sort` (relevance | rating | installs | '
      + 'updated | name), `cursor` (from `nextCursor`), `limit` (capped at 60). Rate limited per client IP; '
      + 'publicly cacheable.',
    tags: publicTags,
    security: [],
    responses: {
      200: { description: '`{ items, facets, total, nextCursor }`' },
      400: { description: 'Invalid query parameter' },
      404: { description: 'The public directory is turned off' },
      429: { description: 'Rate limited' },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/public/plugins/categories',
    summary: 'Public directory categories',
    description: 'Every category with its live listing count and top listings.',
    tags: publicTags,
    security: [],
    responses: { 200: { description: '`{ categories }`' }, 404: { description: 'The public directory is turned off' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/public/plugins/sitemap',
    summary: 'Public directory sitemap entries',
    description: 'Every public listing\'s publisher, name and last update, for building `/sitemap.xml`.',
    tags: publicTags,
    security: [],
    responses: { 200: { description: '`{ entries }`' }, 404: { description: 'The public directory is turned off' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/public/plugins/{publisher}/{name}',
    summary: 'Public plugin page data',
    description: 'One public listing: card fields, README (sanitized HTML), versions, configuration contract, '
      + 'supply-chain facts, advisories and rating distribution. Unknown, paused or suspended listings are 404.',
    tags: publicTags,
    security: [],
    responses: { 200: { description: '`{ listing }`' }, 404: { description: 'Not a public listing' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/public/plugins/{publisher}/{name}/versions/{version}/sbom',
    summary: 'Download a listed version\'s SBOM',
    description: 'The SPDX JSON SBOM of a listed, non-yanked version\'s public image, read from its signed '
      + 'attestation. Anonymous; publicly cacheable.',
    tags: publicTags,
    security: [],
    responses: {
      200: { description: 'SPDX JSON document (application/spdx+json, served as an attachment)' },
      404: { description: 'Not a listed version (unknown, yanked or paused)' },
      409: { description: 'IMAGE_VERIFICATION_FAILED — no SBOM attestation verified' },
      503: { description: 'Too many SBOM verifications in progress; retry after `Retry-After` seconds' },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins',
    summary: 'List plugins',
    description: 'List plugins with pagination, filtering, and sorting.',
    tags,
    security: auth,
    responses: { 200: { description: 'Paginated list of plugins' }, 401: { description: 'Unauthorized' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/find',
    summary: 'Find a single plugin',
    description: 'Find a single plugin matching the query filters. For a plugin that runs on its own image, '
      + 'the image\'s cosign signature is verified first; `imageDigest` in the response is the verified digest '
      + 'pipelines pin CodeBuild to. `name` matches exactly. A yanked version resolves only when pinned exactly '
      + '(by `id` or an exact `version`). The answer is `{ plugin, warnings }`: `warnings` lists '
      + '`PLUGIN_DEPRECATED` / `PLUGIN_YANKED` notices ({ code, message }) for the resolved version.',
    tags,
    security: auth,
    responses: {
      200: { description: '`{ plugin, warnings }`' },
      404: { description: 'Not found' },
      409: { description: 'IMAGE_VERIFICATION_FAILED — the plugin image has no signed digest, or its signature did not verify' },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/lookup',
    summary: 'Resolve a single plugin (synth)',
    description: 'Same as `GET /plugins/find` with the filter in the body — the endpoint pipeline synth resolves '
      + 'plugins through. Verifies the plugin image signature before returning it. Synth prints the answer\'s '
      + '`warnings` (deprecated / yanked-but-pinned versions).',
    tags,
    security: auth,
    responses: {
      200: { description: '`{ plugin, warnings }`' },
      400: { description: 'Missing or invalid filter' },
      404: { description: 'Not found' },
      409: { description: 'IMAGE_VERIFICATION_FAILED — the plugin image has no signed digest, or its signature did not verify' },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/{id}/sbom',
    summary: 'Download a plugin image SBOM',
    description: 'The SPDX JSON SBOM of the plugin image, read from its signed in-toto attestation — so the '
      + 'document returned is exactly what the platform generated and signed at build time.',
    tags,
    security: auth,
    responses: {
      200: { description: 'SPDX JSON document (application/spdx+json, served as an attachment)' },
      404: { description: 'Plugin not found, or the plugin has no image' },
      409: { description: 'IMAGE_VERIFICATION_FAILED — no SBOM attestation verified against the plugin-signing key' },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/{id}',
    summary: 'Get plugin by ID',
    tags,
    security: auth,
    responses: { 200: { description: 'Plugin details' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins',
    summary: 'Upload a plugin',
    description: 'Upload a plugin ZIP (multipart part `plugin`). Builds, signs and scans the image, then saves the '
      + 'version. Optional parts: `visibility`, and `metadata` — a JSON object of catalog edits (summary, '
      + 'description, displayName, category, keywords, license, homepageUrl, sourceUrl, documentationUrl, icon, '
      + 'changelog, readme; `null` clears a field). When `metadata` is absent every value detected from the '
      + 'package is accepted. Execution-contract keys in `metadata` are refused with 400.',
    tags,
    security: auth,
    responses: { 202: { description: 'Plugin build queued' }, 400: { description: 'Validation error' }, 429: { description: 'Quota exceeded' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/inspect',
    summary: 'Inspect a plugin zip (dry run)',
    description: 'Parses a plugin ZIP (multipart part `plugin`) without building or storing anything and returns '
      + 'every descriptive catalog field detected from the package: `{ plugin, fields: [{ field, value, source, '
      + 'error }] }`. `source` is spec | readme | dockerfile | derived (or null when nothing was found); a value '
      + 'that fails validation comes back blank with its `error`. Same zip bounds as upload; rate limited; '
      + 'requires plugins:write.',
    tags,
    security: auth,
    responses: { 200: { description: 'Detected catalog fields' }, 400: { description: 'Invalid zip or spec' }, 429: { description: 'Rate limited' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/plugins/{id}',
    summary: 'Update a plugin',
    description: 'Edit a version\'s descriptive catalog fields (summary, description, displayName, category, '
      + 'keywords, license, links, icon, changelog, readme) and its operational flags (isActive, isDefault, '
      + 'visibility, lifecycle, criticality, labels, links, owner). Execution-contract keys (commands, env, '
      + 'secrets, computeType, …) are refused with 400: they change only with a new version. A version that is '
      + 'frozen by a publish request or listed has its catalog details frozen (409).',
    tags,
    security: auth,
    responses: {
      200: { description: 'Plugin updated' },
      400: { description: 'Validation error, or an execution-contract key' },
      404: { description: 'Not found' },
      409: { description: 'PLUGIN_VERSION_FROZEN — catalog details are frozen with the version' },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/plugins/{id}',
    summary: 'Delete a plugin version',
    description: 'Soft-delete a version. A version used by the org\'s pipelines or published to a listing is refused '
      + 'unless `?force=true`, which requires a step-up token (`X-Step-Up-Token`). A version referenced by a pending '
      + 'publish request is never deletable. Deleting the default promotes the next default; the version\'s '
      + '`plugins` quota slot is refunded while its quota period is current.',
    tags,
    security: auth,
    responses: {
      200: { description: 'Plugin deleted (`promotedDefault` when a new default was chosen)' },
      401: { description: 'STEP_UP_REQUIRED — force delete without a step-up token' },
      404: { description: 'Not found' },
      409: { description: 'PLUGIN_VERSION_IN_USE / PLUGIN_VERSION_FROZEN' },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/{id}/deprecate',
    summary: 'Deprecate a plugin version',
    description: 'Body `{ deprecated?: boolean (default true), message?: string }`. A deprecated version keeps '
      + 'resolving with a warning, and is no longer offered by AI plugin selection.',
    tags,
    security: auth,
    responses: { 200: { description: 'Updated version' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/{id}/yank',
    summary: 'Yank a plugin version',
    description: 'Body `{ reason }`. A yanked version stops resolving for ranges, `latest` and the default; an '
      + 'exact pin still resolves with a warning. Yanking the default promotes the next one. A version published '
      + 'to the ecosystem is yanked through a publish request instead (409).',
    tags,
    security: auth,
    responses: { 200: { description: 'Yanked version (`promotedDefault` when a new default was chosen)' }, 404: { description: 'Not found' }, 409: { description: 'PLUGIN_VERSION_FROZEN' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/providers',
    summary: 'List AI providers',
    description: 'List AI providers configured for plugin generation.',
    tags,
    security: auth,
    responses: { 200: { description: 'List of available AI providers with models' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/generate',
    summary: 'Generate plugin via AI',
    description: 'Generate a plugin configuration and Dockerfile from a natural language prompt.',
    tags,
    security: auth,
    responses: { 200: { description: 'Generated plugin configuration and Dockerfile' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/generate/stream',
    summary: 'Stream plugin generation via AI',
    description: 'Generate plugin configuration from a natural language prompt. Streams partial results as SSE events.',
    tags,
    security: auth,
    responses: { 200: { description: 'SSE event stream of partial plugin objects' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/deploy-generated',
    summary: 'Deploy AI-generated plugin',
    description: 'Build Docker image from AI-generated Dockerfile and save plugin to database. Requires admin.',
    tags,
    security: auth,
    responses: { 202: { description: 'Plugin build queued' }, 400: { description: 'Validation error' }, 403: { description: 'Admin required' }, 429: { description: 'Quota exceeded' } },
  });
}
