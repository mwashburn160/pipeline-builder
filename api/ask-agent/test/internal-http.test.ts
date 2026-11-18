// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's token-forwarding clients must resolve their base URLs from the
 * REAL typed `server.services` config (PIPELINE_SERVICE_HOST/PORT,
 * PLUGIN_SERVICE_HOST/PORT — what every deploy sets). They previously read
 * PIPELINE_URL / PLUGIN_URL, which no deploy defines, so a non-default host or
 * port was silently ignored.
 *
 * Nothing is stubbed: the calls go through api-core's real http-client to a
 * real local HTTP server per peer service, so which PORT a request lands on is
 * the service-discovery assertion.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';

/** One request a peer server received. */
interface Seen { port: number; method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const seen: Seen[] = [];
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, s: Seen) => void;
const ok: Handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); };
let handler: Handler = ok;

const servers = await Promise.all(Array.from({ length: 6 }, () => new Promise<http.Server>((resolve) => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const s: Seen = { port: (srv.address() as AddressInfo).port, method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      handler(req, res, s);
    });
  });
  srv.listen(0, '127.0.0.1', () => resolve(srv));
})));
const [PIPELINE, PLUGIN, PLATFORM, COMPLIANCE, REPORTING, QUOTA] = servers.map((s) => (s.address() as AddressInfo).port) as [number, number, number, number, number, number];

for (const [name, port] of [['PIPELINE', PIPELINE], ['PLUGIN', PLUGIN], ['PLATFORM', PLATFORM], ['COMPLIANCE', COMPLIANCE], ['REPORTING', REPORTING], ['QUOTA', QUOTA]] as const) {
  process.env[`${name}_SERVICE_HOST`] = '127.0.0.1';
  process.env[`${name}_SERVICE_PORT`] = String(port);
}
// Set to prove the dead env vars are NOT consulted.
process.env.PIPELINE_URL = 'http://wrong-pipeline:1';
process.env.PLUGIN_URL = 'http://wrong-plugin:1';
// Short enough for a hung peer to be observable here; small enough cap to exceed.
process.env.ASK_HTTP_TIMEOUT_MS = '400';
process.env.ASK_HTTP_MAX_RESPONSE_BYTES = '4096';

const {
  pipelineClient, pluginClient, platformClient, complianceClient, reportingClient, quotaClient, readInstanceEmailStatus,
  GENERATION_TIMEOUT_MS, HTTP_TIMEOUT_MS,
} = await import('../src/services/internal-http.js');
const { DownstreamError } = await import('../src/services/downstream-error.js');
const { AI_REQUEST_TIMEOUT_MS } = await import('@pipeline-builder/ai-core');
const { destroySharedHttpAgents } = await import('@pipeline-builder/api-core');

const reply = (body: unknown, status = 200): Handler => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
/** Never answer (until the suite closes the connection). */
const hang: Handler = () => { /* held open */ };

beforeEach(() => {
  seen.length = 0;
  handler = ok;
});
afterAll(async () => {
  destroySharedHttpAgents();
  await Promise.all(servers.map((srv) => new Promise<void>((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); })));
});

describe('internal-http service discovery', () => {
  it('pipelineClient targets server.services.pipelineHost:pipelinePort with the user token', async () => {
    await pipelineClient('Bearer USER').get('/pipelines?limit=1');
    expect(seen[0]).toMatchObject({ port: PIPELINE, method: 'GET', url: '/pipelines?limit=1' });
    expect(seen[0]!.headers.authorization).toBe('Bearer USER');
  });

  it('pluginClient targets server.services.pluginHost:pluginPort', async () => {
    await pluginClient('Bearer USER').post('/plugins/generate', { prompt: 'x' });
    expect(seen[0]).toMatchObject({ port: PLUGIN, method: 'POST', url: '/plugins/generate' });
    expect(JSON.parse(seen[0]!.body)).toEqual({ prompt: 'x' });
  });
});

describe('internal-http — on-behalf marker', () => {
  it('adds a fresh signed X-PB-On-Behalf marker per call when the client is bound to a caller', async () => {
    const client = pipelineClient('Bearer USER', { sub: 'u1', organizationId: 'org-1' });
    await client.get('/pipelines');
    await client.get('/pipelines');
    const markers = seen.map((r) => r.headers['x-pb-on-behalf']);
    expect(markers.every((m) => typeof m === 'string' && m.split('.').length === 3)).toBe(true);
    expect(markers[0]).not.toBe(markers[1]);
    // The user's bearer is still the Authorization — the marker sits beside it.
    expect(seen[0]!.headers.authorization).toBe('Bearer USER');
  });

  it('sends no marker from an unbound client (the hop is billed as usual)', async () => {
    await pipelineClient('Bearer USER').get('/pipelines');
    expect(seen[0]!.headers['x-pb-on-behalf']).toBeUndefined();
  });
});

describe('internal-http — request correlation', () => {
  it('forwards the turn\'s X-Request-Id from the ambient audit context to every downstream call', async () => {
    const { runWithAuditContext } = await import('@pipeline-builder/api-core');
    await runWithAuditContext({ requestId: 'req-turn-42' }, () => pipelineClient('Bearer USER').post('/pipelines/generate', { prompt: 'x' }));
    expect(seen[0]!.headers['x-request-id']).toBe('req-turn-42');
  });

  it('sends no X-Request-Id outside a request scope', async () => {
    await pipelineClient('Bearer USER').get('/pipelines');
    expect(seen[0]!.headers['x-request-id']).toBeUndefined();
  });
});

describe('internal-http — the diagnosis clients', () => {
  /**
   * Every client the agent's tools use resolves from the SAME typed
   * `server.services` config and forwards the CALLER's bearer. The agent holds
   * no service principal, so a client that minted its own identity would let a
   * tool read something the asking user cannot.
   */
  it.each([
    ['platformClient', () => platformClient('Bearer USER'), '/config', PLATFORM],
    ['complianceClient', () => complianceClient('Bearer USER'), '/compliance/notification-preferences', COMPLIANCE],
    ['reportingClient', () => reportingClient('Bearer USER'), '/reports/execution/dora', REPORTING],
    ['quotaClient', () => quotaClient('Bearer USER'), '/quotas', QUOTA],
  ])('%s targets its configured host:port and forwards the user token', async (_name, make, path, port) => {
    await make().get(path);
    expect(seen[0]).toMatchObject({ port, url: path });
    expect(seen[0]!.headers.authorization).toBe('Bearer USER');
  });

  it('forwards the user token on POST too (the compliance dry-run)', async () => {
    await complianceClient('Bearer USER').post('/compliance/validate/pipeline/dry-run', { attributes: {} });
    expect(seen[0]).toMatchObject({ port: COMPLIANCE, method: 'POST', url: '/compliance/validate/pipeline/dry-run' });
    expect(seen[0]!.headers.authorization).toBe('Bearer USER');
  });
});

describe('internal-http error surface', () => {
  it('reports status only — never the downstream error body (it reaches the model/user)', async () => {
    handler = reply({ message: 'SELECT * FROM secrets failed', stack: 'at internal.js:1' }, 500);
    await expect(pipelineClient('Bearer USER').get('/pipelines/x')).rejects.toThrow(/^GET \/pipelines\/x -> 500$/);
  });

  it('a 429 carries the peer\'s ErrorCode (and nothing else from the body), so a tool can name the limit', async () => {
    handler = reply({ success: false, message: 'over quota for org-1 (secret detail)', code: 'AI_MEMBER_SHARE_EXCEEDED' }, 429);
    const err = await pipelineClient('Bearer USER').post('/pipelines/generate', {}, { generation: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownstreamError);
    expect(err).toMatchObject({ status: 429, code: 'AI_MEMBER_SHARE_EXCEEDED', message: 'POST /pipelines/generate -> 429' });
    // A quota refusal is reported, not sat through: the client never re-sends it.
    expect(seen).toHaveLength(1);
  });

  it('ignores a 429 code that is not a plain ErrorCode identifier', async () => {
    handler = reply({ code: 'drop table; <script>' }, 429);
    const err = await pipelineClient('Bearer USER').get('/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: undefined });
  });
});

describe('internal-http — timeouts and the turn\'s abort signal', () => {
  it('a delegated generation gets at least the AI request budget, an ordinary call the short timeout', () => {
    expect(GENERATION_TIMEOUT_MS).toBeGreaterThanOrEqual(AI_REQUEST_TIMEOUT_MS + 30_000);
    expect(GENERATION_TIMEOUT_MS).toBeGreaterThan(HTTP_TIMEOUT_MS);
  });

  it('releases a forwarded call when the TURN aborts (client disconnect)', async () => {
    handler = hang;
    const ctrl = new AbortController();
    const pending = pluginClient('Bearer USER', undefined, ctrl.signal).post('/plugins/generate', { prompt: 'x' }, { generation: true });
    // Let the request reach the peer before the user goes away.
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort(new Error('client went away'));
    await expect(pending).rejects.toThrow('client went away');
  });

  it('never sends a call whose turn has ALREADY aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('gone'));
    await expect(pipelineClient('Bearer USER', undefined, ctrl.signal).get('/pipelines')).rejects.toThrow('gone');
    expect(seen).toHaveLength(0);
  });

  it('a hung peer fails the call at the ordinary timeout', async () => {
    handler = hang;
    const started = Date.now();
    await expect(reportingClient('Bearer USER').get('/reports/slow')).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(HTTP_TIMEOUT_MS * 3);
    // One attempt, not a retried GET.
    expect(seen).toHaveLength(1);
  });

  it('refuses a response body over the cap rather than buffering it', async () => {
    handler = reply({ rows: 'x'.repeat(10_000) });
    await expect(quotaClient('Bearer USER').get('/quotas')).rejects.toThrow(/exceeded 4096 bytes/);
  });
});

// ---------------------------------------------------------------------------
// The ONE call that does not forward the caller's token.
//
// `GET /internal/notify-email/status` is platform's AUTHORITATIVE answer to
// "can this instance send email at all", and it is `requireInternalService`, so
// it takes ask-agent's OWN service identity. That is safe precisely because the answer
// is one instance-wide boolean — no org, no recipient, no provider — and because
// ask-agent is NOT a caller of the send route, so the same identity can never make
// platform send anything.
// ---------------------------------------------------------------------------

/** The claims of a compact JWS, without verifying it (the payload is all we assert). */
function claimsOf(header: string): Record<string, unknown> {
  const token = header.replace(/^Bearer /, '');
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('readInstanceEmailStatus — the authoritative email switch', () => {
  it('asks platform\'s INTERNAL status route with ask-agent\'s own SERVICE token, not a user bearer', async () => {
    handler = reply({ data: { enabled: true } });
    await readInstanceEmailStatus();
    expect(seen[0]).toMatchObject({ port: PLATFORM, url: '/internal/notify-email/status' });
    const auth = seen[0]!.headers.authorization!;
    expect(auth).not.toBe('Bearer USER');
    // A service principal naming THIS service — the claim the route's caller
    // list matches, cryptographically bound to ask-agent's signing key.
    expect(claimsOf(auth)).toMatchObject({ sub: 'service:ask-agent', principalType: 'service', role: 'member' });
  });

  it.each([
    [{ data: { enabled: true } }, 'enabled'],
    [{ data: { enabled: false } }, 'disabled'],
    // Platform answers through `sendSuccess`; the endpoint's contract reads the
    // envelope's `data`, so a bare body — like one that does not answer — is
    // not an answer.
    [{ enabled: true }, 'unknown'],
    [{ data: {} }, 'unknown'],
  ])('maps %j to %s', async (body, expected) => {
    handler = reply(body);
    await expect(readInstanceEmailStatus()).resolves.toBe(expected);
  });

  it('resolves UNKNOWN (never "disabled") when platform refuses the token', async () => {
    handler = reply({ message: 'Internal service calls only' }, 403);
    await expect(readInstanceEmailStatus()).resolves.toBe('unknown');
  });

  it('resolves UNKNOWN when platform is unreachable — and never throws into the turn', async () => {
    handler = (req) => { req.socket.destroy(); };
    await expect(readInstanceEmailStatus()).resolves.toBe('unknown');
  });
});
