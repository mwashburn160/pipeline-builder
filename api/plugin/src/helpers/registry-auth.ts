// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry addressing + the short-lived Docker credential every registry client
 * the plugin service runs (buildctl, crane, syft, cosign) authenticates with.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { signServiceToken, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';

export interface RegistryInfo {
  host: string;
  port: number;
  network: string;
  /**
   * BuildKit speaks plain HTTP to the registry when true (in-cluster registry
   * with no TLS). Pushed via `registry.insecure=true` on the buildctl output.
   */
  http: boolean;
}

/**
 * The registry repository (no tag, no digest) a plugin's image lives in.
 * Namespaced by the OWNING org so the token service's per-org scopes apply:
 * - `system` org → `<host>:<port>/system/<name>`
 * - any tenant org → `<host>:<port>/org-<orgId>/<name>`
 */
export function imageRepository(name: string, registry: RegistryInfo, orgId?: string): string {
  const namespace = !orgId || orgId === SYSTEM_ORG_ID ? 'system' : `org-${orgId}`;
  return `${registry.host}:${registry.port}/${namespace}/${name}`;
}

/**
 * What a registry credential may do. `push` carries `plugins:write` — the
 * image-registry authorizer grants push on the org's namespace for
 * `isAdmin || permissions.includes('plugins:write')` (auth-resolver
 * canWritePlugins) — so a member-role token with just that permission can push
 * without the org-wide `isAdmin` blast radius an owner token would leak. `pull`
 * carries no permission at all: pull is open to every member of the owning org
 * (and `system/*` to everyone).
 */
export type RegistryAccess = 'push' | 'pull';

/**
 * Mint a platform JWT (TTL = the operation's window, passed by the caller) and
 * write it to a fresh `$DOCKER_CONFIG/config.json` as Basic-auth credentials for
 * the registry. Returns the directory; the CALLER removes it once the operation
 * that uses it completes. image-registry's /token endpoint verifies the JWT and
 * mints a scoped Bearer token in response to the registry's bearer challenge.
 * Username is informational; auth-resolver path 1 uses the password only.
 *
 * We write credentials for **two** hosts:
 * 1. `registry:5000` — the in-cluster registry address we push to.
 * 2. The host derived from `PLATFORM_BASE_URL` — the token realm the registry
 *    redirects clients to (see deploy/.../registry.yaml's
 *    REGISTRY_AUTH_TOKEN_REALM, which is the public URL so external Docker
 *    clients can reach it). Docker clients only send Basic auth to hosts
 *    present in `auths`, so without this second entry a client hops to the
 *    public realm with no credentials and gets 401.
 */
export function writeAuthConfig(registry: RegistryInfo, orgId: string, ttlSeconds: number, access: RegistryAccess = 'push'): string {
  // Signed as `plugin` — this IS the plugin service, and since a service
  // holds only its own key. image-registry grants push to a SERVICE principal
  // only when it is `plugin` and carries `plugins:write`.
  const password = signServiceToken({
    serviceName: 'plugin',
    orgId,
    role: 'member',
    permissions: access === 'push' ? ['plugins:write'] : [],
    ttlSeconds,
  });
  return writeDockerConfig(registry, '_token', password);
}

/**
 * Write `username:password` to a fresh `$DOCKER_CONFIG/config.json` for the
 * registry and its token realm (see {@link writeAuthConfig}). Returns the
 * directory; the caller removes it. Also used for the quarantine build's
 * registry-only credential (image-registry `/internal/quarantine/:id/credential`).
 */
export function writeDockerConfig(registry: RegistryInfo, username: string, password: string): string {
  // Write OUTSIDE any build context. The previous in-context `.docker/config.json`
  // was baked into published images by a plugin Dockerfile's `COPY . .`, leaking
  // an owner-scoped platform JWT. Every client reads it via the DOCKER_CONFIG
  // env, so its location is independent of the build context.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-dockercfg-'));
  const auth = Buffer.from(`${username}:${password}`).toString('base64');

  const auths: Record<string, { auth: string }> = {
    [`${registry.host}:${registry.port}`]: { auth },
  };

  // Add the token-realm host so clients send Basic auth when the registry
  // redirects them to the realm to mint a bearer token. URL.host already
  // includes any non-default port (e.g. `nginx:8080`), which matches how
  // Docker keys auths.
  //
  // The realm URL is whatever the registry advertises via
  // REGISTRY_AUTH_TOKEN_REALM. In production this is PLATFORM_BASE_URL
  // (public) so external Docker clients can reach it; in local dev it's
  // an in-cluster URL (http://nginx:8080/...) because the published
  // localhost:8443 is not routable from inside the plugin container.
  // Prefer the explicit env var so the plugin stays in lockstep with the
  // registry's advertised realm regardless of which deploy this is.
  const realmUrl = process.env.IMAGE_REGISTRY_TOKEN_REALM
    || (process.env.PLATFORM_BASE_URL ? `${process.env.PLATFORM_BASE_URL}/image-registry/token` : undefined);
  if (realmUrl) {
    try {
      const realmHost = new URL(realmUrl).host;
      if (realmHost) auths[realmHost] = { auth };
    } catch {
      // Malformed URL — skip silently; the in-cluster auth still works
      // for in-cluster realms (or when the registry isn't redirecting).
    }
  }

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths }));
  return dir;
}
