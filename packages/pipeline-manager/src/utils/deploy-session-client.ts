// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner deploy job's ONLY way to the platform: its single-use grant is
 * exchanged once for a session token (`pb_ds_…`, valid to the deploy's
 * deadline), and the session reaches only the facade routes under
 * `/api/pipelines/runner/deploys/<requestId>/` (api-core `runnerDeployPath`):
 *
 *   session        POST {grant} → DeploySessionDto (no Authorization header)
 *   pipeline       GET  — the pipeline, as GET /api/pipelines/:id answers it
 *   plugin-lookup  POST — a plugin lookup, as POST /api/plugins/lookup takes it
 *   progress       POST {stage}
 *   registry       POST DeployRegistryBody (org / pipeline / runner come from the session)
 *   result         POST {code, stage}
 *
 * {@link DeploySessionClient} stands in for the CLI's API client in
 * fetchPipelineProps (the same code `pipeline deploy` runs): its GET of the
 * session's own pipeline and its plugin lookups are re-routed to the facade;
 * every other request is refused BEFORE it is sent. Redirects are never
 * followed (the token goes to the configured platform only).
 */

import {
  DEPLOY_GRANT_PATTERN, DEPLOY_GRANT_REJECTION_REASONS, DEPLOY_SESSION_PATTERN, runnerDeployPath,
  type DeployGrantRejectionReason, type DeployProgressBody, type DeployRegistryBody, type DeployResultBody, type DeploySessionDto, type DeploySessionLeaf,
} from '@pipeline-builder/api-core/pipeline-runners';
import axios from 'axios';
import type { PlatformReadClient } from './api-client.js';
import type { Config } from './config-loader.js';
import { platformHttpsAgent } from './tls.js';
import { TIMEOUTS } from '../config/cli.constants.js';

/** The HTTP the session speaks (paths relative to the platform base URL). Throws with `response.{status,data}` on a non-2xx. */
export interface SessionHttp {
  request(method: 'GET' | 'POST', url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

/** The platform over axios: its CA policy (PLATFORM_CA_BUNDLE), verification always on, no redirects. */
export function defaultSessionHttp(baseUrl: string): SessionHttp {
  const client = axios.create({
    baseURL: baseUrl,
    timeout: TIMEOUTS.HTTP_REQUEST,
    httpsAgent: platformHttpsAgent(true),
    maxRedirects: 0,
    headers: { 'Content-Type': 'application/json' },
  });
  return {
    async request(method, url, body, headers) {
      const res = await client.request({ method, url, ...(body !== undefined ? { data: body } : {}), headers });
      return res.data;
    },
  };
}

/** The grant exchange was refused (401 DEPLOY_GRANT_INVALID): `reason` from the platform, when it sent a known one. */
export class DeployGrantRefusedError extends Error {
  constructor(readonly reason: DeployGrantRejectionReason | undefined) {
    super(`The platform refused the deploy grant${reason ? ` (${reason})` : ''}`);
    this.name = 'DeployGrantRefusedError';
  }
}

const unwrap = (res: unknown): unknown => {
  const r = res as { data?: unknown } | null;
  return r && typeof r === 'object' && 'data' in r && r.data && typeof r.data === 'object' ? r.data : res;
};
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Exchange the grant for a session. The grant rides in the body only. */
export async function exchangeDeployGrant(opts: { requestId: string; grant: string; http: SessionHttp }): Promise<DeploySessionDto> {
  if (!DEPLOY_GRANT_PATTERN.test(opts.grant)) throw new Error('Not a deploy grant: refusing to send it');
  let res: unknown;
  try {
    res = await opts.http.request('POST', runnerDeployPath(opts.requestId, 'session'), { grant: opts.grant }, {});
  } catch (err) {
    const r = (err as { response?: { status?: number; data?: { code?: string; details?: { reason?: unknown } } } }).response;
    if (r?.status === 401) {
      const reason = r.data?.details?.reason;
      throw new DeployGrantRefusedError((DEPLOY_GRANT_REJECTION_REASONS as readonly unknown[]).includes(reason) ? reason as DeployGrantRejectionReason : undefined);
    }
    throw err;
  }
  const s = unwrap(res) as Partial<DeploySessionDto> | null;
  if (!s || typeof s !== 'object' || typeof s.sessionToken !== 'string' || !DEPLOY_SESSION_PATTERN.test(s.sessionToken)
    || s.requestId !== opts.requestId || !str(s.pipelineId) || !str(s.region) || !str(s.pipelineName) || !str(s.stackName)
    || !str(s.toolchainRelease) || typeof s.protocol !== 'number' || !str(s.expiresAt)) {
    throw new Error('The platform answered the grant exchange with no usable session for this request');
  }
  return {
    sessionToken: s.sessionToken,
    expiresAt: s.expiresAt,
    requestId: s.requestId,
    pipelineId: s.pipelineId,
    region: s.region,
    pipelineName: s.pipelineName,
    stackName: s.stackName,
    toolchainRelease: s.toolchainRelease,
    protocol: s.protocol,
  };
}

/** The pipeline route as the CLI's config names it (what fetchPipelineProps builds its GET from). */
const PIPELINE_URL = '/api/pipelines';
const PLUGIN_LOOKUP_URL = '/api/plugins/lookup';

/** A session-scoped stand-in for the CLI's API client: the facade routes of ONE deploy request, nothing else. */
export class DeploySessionClient implements PlatformReadClient {
  private readonly http: SessionHttp;
  private readonly session: DeploySessionDto;
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string; session: DeploySessionDto; http?: SessionHttp }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.session = opts.session;
    this.http = opts.http ?? defaultSessionHttp(this.baseUrl);
  }

  getConfig(): Config {
    return {
      api: {
        baseUrl: this.baseUrl,
        timeout: TIMEOUTS.HTTP_REQUEST,
        pipelineUrl: PIPELINE_URL,
        pipelineTemplateUrl: '/api/pipeline-templates',
        pluginUrl: '/api/plugins',
        pluginUploadUrl: '/api/plugins/upload',
        rejectUnauthorized: true,
      },
      // The session token is used by this client only — never handed out as a CLI credential.
      auth: { token: '' },
    };
  }

  private send<T>(method: 'GET' | 'POST', leaf: DeploySessionLeaf, body?: unknown): Promise<T> {
    return this.http.request(method, runnerDeployPath(this.session.requestId, leaf), body, { Authorization: `Bearer ${this.session.sessionToken}` }) as Promise<T>;
  }

  private refuse(method: string, url: string): never {
    throw new Error(`The deploy session reaches only its own facade routes: refusing ${method} ${url}`);
  }

  async get<T = unknown>(url: string): Promise<T> {
    if (url === `${PIPELINE_URL}/${this.session.pipelineId}` || url === `${PIPELINE_URL}/${encodeURIComponent(this.session.pipelineId)}`) {
      return this.send<T>('GET', 'pipeline');
    }
    return this.refuse('GET', url);
  }

  async post<T = unknown>(url: string, data?: unknown): Promise<T> {
    if (url === PLUGIN_LOOKUP_URL) return this.send<T>('POST', 'plugin-lookup', data);
    return this.refuse('POST', url);
  }

  progress(stage: DeployProgressBody['stage']): Promise<unknown> {
    return this.send('POST', 'progress', { stage } satisfies DeployProgressBody);
  }

  registry(body: DeployRegistryBody): Promise<unknown> {
    return this.send('POST', 'registry', body);
  }

  result(body: DeployResultBody): Promise<unknown> {
    return this.send('POST', 'result', body);
  }
}
