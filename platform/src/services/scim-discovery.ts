// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** SCIM discovery documents: what a validator or IdP fetches first. */

import type { ScimListResponse } from './scim-filter.js';
import { scimBaseUrl } from './scim-render.js';
import { SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_MAX_COUNT, SCIM_USER_SCHEMA } from '../constants/scim.js';

// ---------------------------------------------------------------------------
// Discovery documents (RFC 7643 §§5-6) — what a validator fetches first
// ---------------------------------------------------------------------------

/** `GET /ServiceProviderConfig`: exactly what this implementation supports, so a
 *  client never attempts bulk, sort or a complex filter and gets a 400. */
export async function serviceProviderConfig(): Promise<Record<string, unknown>> {
  const baseUrl = await scimBaseUrl();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://pipeline-builder.dev/docs/authentication',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'A service-account key carrying the `scim` scope, presented as `Authorization: Bearer pb_sa_…`.',
      specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
      primary: true,
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

/** `GET /ResourceTypes` — the two resources this service exposes. */
export async function resourceTypes(): Promise<ScimListResponse<Record<string, unknown>>> {
  const baseUrl = await scimBaseUrl();
  const Resources = [
    { id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA, description: 'Organization member' },
    { id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCIM_GROUP_SCHEMA, description: 'Directory group mapped to roles' },
  ].map((r) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    ...r,
    schemaExtensions: [],
    meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/${r.id}` },
  }));
  return { schemas: [SCIM_LIST_SCHEMA], totalResults: Resources.length, startIndex: 1, itemsPerPage: Resources.length, Resources };
}

/** `GET /Schemas` — the attributes actually honoured, so a client can map to
 *  them rather than discovering by trial. Only the modelled subset is declared. */
export async function schemas(): Promise<ScimListResponse<Record<string, unknown>>> {
  const attr = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    type: 'string',
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...over,
  });
  const Resources = [
    {
      id: SCIM_USER_SCHEMA,
      name: 'User',
      description: 'Organization member',
      attributes: [
        attr('userName', { required: true, uniqueness: 'server' }),
        attr('externalId'),
        attr('displayName'),
        { ...attr('name'), type: 'complex', subAttributes: [attr('givenName'), attr('familyName'), attr('formatted')] },
        { ...attr('emails'), type: 'complex', multiValued: true, subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })] },
        attr('active', { type: 'boolean' }),
        { ...attr('groups'), type: 'complex', multiValued: true, mutability: 'readOnly', subAttributes: [attr('value'), attr('display')] },
      ],
    },
    {
      id: SCIM_GROUP_SCHEMA,
      name: 'Group',
      description: 'Directory group mapped to roles',
      attributes: [
        attr('displayName', { required: true, uniqueness: 'server' }),
        attr('externalId'),
        { ...attr('members'), type: 'complex', multiValued: true, subAttributes: [attr('value'), attr('display')] },
      ],
    },
  ];
  const baseUrl = await scimBaseUrl();
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: Resources.length,
    startIndex: 1,
    itemsPerPage: Resources.length,
    Resources: Resources.map((s) => ({
      ...s,
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${s.id}` },
    })),
  };
}
