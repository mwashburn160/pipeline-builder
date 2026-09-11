// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Token-forwarding client for the agent's read/propose tools. The "Ask" agent acts
// STRICTLY on behalf of the calling user by forwarding their bearer token to the
// existing service routes — never a service principal — so compliance, quota,
// permissions, and tenancy apply exactly as they do for the user's own requests.
// Base URLs are service-discovery env vars (in-cluster DNS / docker service name).

/** Minimal service client that forwards the caller's Authorization header. */
export interface ServiceClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

// Per-call timeout so a hung downstream service can't wedge the whole SSE turn
// (the tool `execute` runs inside the model's fullStream await). Mirrors the
// bounded external calls in api/pipeline's git-analysis client.
const HTTP_TIMEOUT_MS = parseInt(process.env.ASK_HTTP_TIMEOUT_MS || '30000', 10);

function makeClient(baseUrl: string, authHeader: string): ServiceClient {
  const headers = { 'Content-Type': 'application/json', 'Authorization': authHeader };
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* non-JSON body */ }
      throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${detail}`.trim());
    }
    return res.json();
  };
  return {
    get: (path) => call(path, { method: 'GET' }),
    post: (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}

/** Client for the pipeline service (`/pipelines/*`), forwarding the user token. */
export function pipelineClient(authHeader: string): ServiceClient {
  return makeClient(process.env.PIPELINE_URL || 'http://pipeline:3000', authHeader);
}

/** Client for the plugin service (`/plugins/*`), forwarding the user token. */
export function pluginClient(authHeader: string): ServiceClient {
  return makeClient(process.env.PLUGIN_URL || 'http://plugin:3000', authHeader);
}
