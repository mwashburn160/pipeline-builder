// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A local, in-process HTTP stand-in for the platform's public API — just the
 * routes the CLI's sign-in, status, pipeline and synth paths call, answering in
 * the envelopes the real services send (`{ success, statusCode, data }`).
 *
 * Every request is RECORDED (method, path, query, headers, parsed body) so a
 * test asserts on what the CLI actually put on the wire, not on what a mock was
 * called with. Listens on 127.0.0.1 with an ephemeral port: no network.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/** One toolchain release, as `/plugins/lookup` reports it for the managed names. */
export const TOOLCHAIN = {
  releaseVersion: '1.1.17',
  resolvedVia: 'default',
  versions: { awsCdk: '2.1148.1', cdkAssets: '4.8.0', pipelineManager: '4.7.0', node: '26.13.1' },
} as const;

const DIGEST = (c: string): string => `sha256:${c.repeat(64)}`;

/** The `pipeline-bootstrap` half — a prebuilt, signed BuildImage in the system repository. */
function bootstrapRecord(): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-0000000000b0',
    orgId: 'system',
    name: 'pipeline-bootstrap',
    version: TOOLCHAIN.releaseVersion,
    pluginType: 'BuildImage',
    buildType: 'prebuilt',
    imageDigest: DIGEST('b'),
    imageRepository: 'system/pipeline-bootstrap',
    commands: [],
    installCommands: [],
    metadata: {},
    env: {},
    secrets: [],
    toolchain: TOOLCHAIN.versions,
  };
}

/** The `cdk-synth` half — the synth step's plugin. */
function cdkSynthRecord(): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-0000000000c5',
    orgId: 'system',
    name: 'cdk-synth',
    description: null,
    keywords: [],
    category: 'infrastructure',
    version: TOOLCHAIN.releaseVersion,
    metadata: {},
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    timeout: null,
    failureBehavior: 'fail',
    secrets: [],
    primaryOutputDirectory: 'cdk.out',
    env: {},
    buildArgs: {},
    installCommands: [],
    commands: ['pipeline-manager pipeline synth --quiet --no-notices'],
    dockerfile: null,
    buildType: 'prebuilt',
    imageDigest: DIGEST('c'),
    imageRepository: 'system/cdk-synth',
    visibility: 'public',
    isDefault: false,
    isActive: true,
    toolchain: TOOLCHAIN.versions,
  };
}

/** Knobs a test flips to drive the CLI down a particular branch. */
export interface StubState {
  /** `authorization_pending` answers before the device token is granted. */
  pendingPolls: number;
  /** Access tokens the protected routes accept. */
  validTokens: Set<string>;
  /** The refresh token `/auth/refresh` accepts (single use: rotated on success). */
  refreshToken: string;
  /** Answer `/auth/refresh` with this status instead (e.g. 401 = revoked). */
  refreshStatus?: number;
  /** Counter behind minted access tokens, so each one is distinguishable. */
  minted: number;
  pipelines: Map<string, Record<string, unknown>>;
}

export interface StubPlatform {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly state: StubState;
  /** Requests to one path (optionally one method), in arrival order. */
  calls(path: string, method?: string): RecordedRequest[];
  close(): Promise<void>;
}

const USER = { email: 'dev@acme.test', organizationId: 'org-1', activeOrgName: 'Acme' };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function ok(res: ServerResponse, data: unknown, status = 200): void {
  send(res, status, { success: true, statusCode: status, data });
}

function fail(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  send(res, status, { success: false, statusCode: status, message, ...extra });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startStubPlatform(): Promise<StubPlatform> {
  const requests: RecordedRequest[] = [];
  const state: StubState = {
    pendingPolls: 1,
    validTokens: new Set(),
    refreshToken: 'rt-1',
    minted: 0,
    pipelines: new Map(),
  };
  let polls = 0;
  const mint = (): string => {
    state.minted += 1;
    const token = `at-${state.minted}`;
    state.validTokens.add(token);
    return token;
  };
  const bearer = (req: IncomingMessage): string | undefined =>
    /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const parsed = new URL(req.url ?? '/', 'http://stub');
      const body = await readBody(req);
      const rec: RecordedRequest = {
        method: req.method ?? 'GET',
        path: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams),
        headers: req.headers,
        body,
      };
      requests.push(rec);
      const b = (body ?? {}) as Record<string, unknown>;
      const route = `${rec.method} ${rec.path}`;

      // ---- pre-auth ----
      if (route === 'GET /health') return ok(res, { status: 'ok' });
      if (route === 'POST /api/auth/device/code') {
        polls = 0;
        return send(res, 200, {
          device_code: 'dc-secret-1',
          user_code: 'WXYZ-1234',
          verification_uri: `${url}/device`,
          verification_uri_complete: `${url}/device?code=WXYZ-1234`,
          expires_in: 60,
          interval: 1,
        });
      }
      if (route === 'POST /api/auth/device/token') {
        if (b.device_code !== 'dc-secret-1') return send(res, 400, { error: 'invalid_grant' });
        polls += 1;
        if (polls <= state.pendingPolls) return send(res, 400, { error: 'authorization_pending' });
        return send(res, 200, { access_token: mint(), refresh_token: state.refreshToken, token_type: 'Bearer', expires_in: 900 });
      }
      if (route === 'POST /api/auth/refresh') {
        // The CSRF gate: a refresh without the client-type header is refused.
        if (req.headers['x-pb-client'] !== 'cli') return fail(res, 403, 'X-Pb-Client required');
        if (state.refreshStatus) return fail(res, state.refreshStatus, 'Refresh token rejected');
        if (b.refreshToken !== state.refreshToken) return fail(res, 401, 'Refresh token rejected');
        state.refreshToken = `${state.refreshToken}-rotated`;
        return ok(res, { accessToken: mint(), refreshToken: state.refreshToken, expiresIn: 900 });
      }

      // ---- authenticated ----
      const token = bearer(req);
      if (!token || !state.validTokens.has(token)) return fail(res, 401, 'Unauthorized');

      if (route === 'POST /api/auth/switch-org') {
        // Switching mints an ACCESS token only. The decoy refresh token proves
        // the CLI keeps the session's own refresh token instead of this one.
        return ok(res, { accessToken: mint(), refreshToken: 'rt-decoy-must-be-ignored', expiresIn: 600 });
      }
      if (route === 'GET /api/user/profile') return ok(res, { user: USER });

      if (route === 'POST /api/pipelines') {
        const id = `01HZE2EPIPE${String(state.pipelines.size + 1).padStart(15, '0')}`;
        const pipeline = { id, orgId: USER.organizationId, isActive: true, isDefault: false, createdAt: '2026-11-17T00:00:00.000Z', ...b };
        state.pipelines.set(id, pipeline);
        return ok(res, { pipeline }, 201);
      }
      if (route === 'GET /api/pipelines') {
        const pipelines = [...state.pipelines.values()];
        return ok(res, { pipelines, pagination: { total: pipelines.length, hasMore: false } });
      }
      const one = /^\/api\/pipelines\/([^/]+)$/.exec(rec.path);
      if (rec.method === 'GET' && one) {
        const pipeline = state.pipelines.get(one[1]!);
        return pipeline ? ok(res, { pipeline }) : fail(res, 404, 'Pipeline not found');
      }
      if (route === 'POST /api/plugins/lookup') {
        const name = (b.filter as { name?: string } | undefined)?.name;
        if (name === 'pipeline-bootstrap') return ok(res, { plugin: bootstrapRecord(), warnings: [], toolchain: TOOLCHAIN });
        if (name === 'cdk-synth') return ok(res, { plugin: cdkSynthRecord(), warnings: [], toolchain: TOOLCHAIN });
        return fail(res, 404, `No plugin named ${name}`);
      }
      return fail(res, 404, `stub: no route for ${route}`);
    })().catch((error: unknown) => fail(res, 500, String(error)));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    requests,
    state,
    calls: (path, method) => requests.filter((r) => r.path === path && (!method || r.method === method)),
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
