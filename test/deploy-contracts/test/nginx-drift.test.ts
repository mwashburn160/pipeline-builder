// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the four gateway `nginx.conf` copies (docker, minikube, ec2,
 * eks).
 *
 * Unlike jwt.js / metrics.js (one copy, deploy/shared/nginx/), nginx.conf
 * genuinely differs per substrate: docker + minikube terminate TLS themselves,
 * ec2 + eks sit behind an ALB and recover the client from X-Forwarded-For, the
 * k8s targets address services by cluster DNS, and ec2/eks move the admin
 * consoles into admin-uis.conf. Everything ELSE — every API route, its
 * rewrite, its buffering/timeout treatment — must be identical, or a route that
 * works locally 404s / buffers / times out in production (the SSE log-export
 * location existed only in docker until this test found it).
 *
 * So the files are PARSED (comments dropped, directives tokenized), normalized
 * by the declared per-target parameters below, and compared structurally. Any
 * difference must be declared in TARGET_SPECIFIC (with the exact set of targets
 * that carry it) or LOCATION_BODY_VARIES — and a declaration that no longer
 * matches reality fails too, so the allow-list cannot rot.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

// Jest runs with cwd = `platform/`; the deploy tree is at the repo root.

const TARGETS = ['deploy/local/docker', 'deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks'] as const;
type Target = typeof TARGETS[number];

const LOCAL: Target[] = ['deploy/local/docker', 'deploy/local/minikube'];
const AWS: Target[] = ['deploy/aws/ec2', 'deploy/aws/eks'];

/**
 * Per-target PARAMETERS: the one value a directive legitimately takes on each
 * substrate. Normalized to a placeholder before comparison — and a target that
 * uses the OTHER substrate's value is left un-normalized, so it shows up as drift.
 */
const TARGET_PARAMS: Record<Target, { clientXff: string; forwardedProto: string }> = {
  // TLS terminates in nginx: append the peer, the scheme is nginx's own.
  'deploy/local/docker': { clientXff: '$proxy_add_x_forwarded_for', forwardedProto: '$scheme' },
  'deploy/local/minikube': { clientXff: '$proxy_add_x_forwarded_for', forwardedProto: '$scheme' },
  // Behind the ALB: real_ip already resolved the client into $remote_addr, and
  // the ALB's X-Forwarded-Proto is the truth ($scheme would say "http").
  'deploy/aws/ec2': { clientXff: '$remote_addr', forwardedProto: '$http_x_forwarded_proto' },
  'deploy/aws/eks': { clientXff: '$remote_addr', forwardedProto: '$http_x_forwarded_proto' },
};

type Scope = 'main' | 'http' | 'server' | 'location';

/** Declared target-specific directives/blocks: exactly these targets carry them. */
const TARGET_SPECIFIC: { scope: Scope; item: string; targets: Target[]; why: string }[] = [
  { scope: 'main', item: 'pid /tmp/nginx.pid;', targets: ['deploy/local/docker'], why: 'compose runs nginx as UID 101; the default pid path is root-only' },
  { scope: 'http', item: 'resolver 127.0.0.11 valid=30s ipv6=off;', targets: ['deploy/local/docker'], why: 'Docker embedded DNS' },
  { scope: 'http', item: 'resolver kube-dns.kube-system.svc.cluster.local valid=30s ipv6=off;', targets: ['deploy/local/minikube', ...AWS], why: 'cluster DNS' },
  { scope: 'http', item: 'js_import registry_auth from registry-auth.js;', targets: AWS, why: 'registry token-realm rewrite for the public /v2/ route' },
  { scope: 'http', item: 'include /etc/nginx/real-ip.conf;', targets: AWS, why: 'trusted ALB CIDRs, generated per deploy' },
  { scope: 'http', item: 'real_ip_header X-Forwarded-For;', targets: AWS, why: 'client IP behind the ALB' },
  { scope: 'http', item: 'real_ip_recursive on;', targets: AWS, why: 'client IP behind the ALB' },
  { scope: 'http', item: 'map $http_cookie $pb_cookie_without_console', targets: AWS, why: 'admin-uis.conf strips the console cookie' },
  { scope: 'http', item: 'server { listen 8080; server_name localhost; return 301 https://$host:8443$request_uri; }', targets: LOCAL, why: 'local targets terminate TLS: plain :8080 only redirects' },
  { scope: 'server', item: 'listen 8443 ssl;', targets: LOCAL, why: 'local TLS termination' },
  { scope: 'server', item: 'server_name localhost;', targets: LOCAL, why: 'local TLS termination' },
  { scope: 'server', item: 'ssl_certificate /etc/nginx/certs/nginx.crt;', targets: LOCAL, why: 'local TLS termination' },
  { scope: 'server', item: 'ssl_certificate_key /etc/nginx/certs/nginx.key;', targets: LOCAL, why: 'local TLS termination' },
  { scope: 'server', item: 'ssl_protocols TLSv1.3 TLSv1.2;', targets: LOCAL, why: 'local TLS termination' },
  { scope: 'server', item: 'ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;', targets: LOCAL, why: 'local TLS termination' },
  { scope: 'server', item: 'ssl_prefer_server_ciphers off;', targets: LOCAL, why: 'local TLS termination' },
  { scope: 'server', item: 'listen 8080;', targets: AWS, why: 'the ALB terminates TLS and forwards plain HTTP' },
  { scope: 'server', item: 'server_name _;', targets: AWS, why: 'the ALB terminates TLS and forwards plain HTTP' },
  { scope: 'server', item: 'include /etc/nginx/admin-uis.conf;', targets: AWS, why: 'admin consoles are opt-in (admin-uis.conf vs admin-uis-disabled.conf)' },
  { scope: 'location', item: '/grafana/', targets: LOCAL, why: 'inline admin console (aws: admin-uis.conf)' },
  { scope: 'location', item: '/pgadmin/', targets: LOCAL, why: 'inline admin console (aws: admin-uis.conf)' },
  { scope: 'location', item: '/mongo-express/', targets: LOCAL, why: 'inline admin console (aws: admin-uis.conf)' },
  { scope: 'location', item: '/kiali/', targets: ['deploy/local/minikube'], why: 'Istio console; docker has no mesh (aws: admin-uis.conf)' },
  { scope: 'location', item: '/v2/', targets: AWS, why: 'public registry endpoint for off-cluster docker clients' },
];

/** Locations present everywhere whose BODY differs per target, and why. */
const LOCATION_BODY_VARIES: Record<string, string> = {
  // Local targets resolve the registry lazily through a variable so nginx
  // still boots when the registry container is absent; aws always runs it.
  '/registry/': 'lazy upstream variable on local targets',
};

// -- A minimal nginx config parser --------------------------------------------

interface Directive { name: string; args: string[]; block?: Directive[] }

function tokenize(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}' || c === ';') { out.push(c); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !'{};'.includes(src[j])) j++;
    out.push(src.slice(i, j));
    i = j;
  }
  return out;
}

function parse(tokens: string[]): Directive[] {
  let i = 0;
  const block = (): Directive[] => {
    const ds: Directive[] = [];
    while (i < tokens.length) {
      if (tokens[i] === '}') { i++; return ds; }
      const words: string[] = [];
      while (i < tokens.length && tokens[i] !== ';' && tokens[i] !== '{') words.push(tokens[i++]);
      if (i >= tokens.length) throw new Error(`unterminated directive: ${words.join(' ')}`);
      const [name, ...args] = words;
      if (tokens[i++] === ';') ds.push({ name, args });
      else ds.push({ name, args, block: block() });
    }
    return ds;
  };
  return block();
}

function serialize(ds: Directive[], target: Target): string {
  const p = TARGET_PARAMS[target];
  return ds.map((d) => {
    // Cluster-DNS service names ↔ compose service names.
    let args = d.args.map((a) => a.replace(/\.pipeline-builder\.svc\.cluster\.local/g, ''));
    if (d.name === 'proxy_set_header' && args[0] === 'X-Forwarded-For' && args[1] === p.clientXff) args = [args[0], '<client-xff>'];
    if (d.name === 'proxy_set_header' && args[0] === 'X-Forwarded-Proto' && args[1] === p.forwardedProto) args = [args[0], '<forwarded-proto>'];
    const head = [d.name, ...args].join(' ');
    return d.block ? `${head} { ${serialize(d.block, target)} }` : `${head};`;
  }).join(' ');
}

interface Model { main: string[]; http: string[]; server: string[]; locations: Map<string, string>; regexOrder: string[] }

function model(target: Target): Model {
  const ds = parse(tokenize(readFileSync(join(REPO_ROOT, target, 'nginx/nginx.conf'), 'utf-8')));
  const http = ds.find((d) => d.name === 'http');
  if (!http?.block) throw new Error(`${target}: no http block`);
  const gateways = http.block.filter((d) => d.name === 'server' && d.block?.some((c) => c.name === 'location'));
  if (gateways.length !== 1) throw new Error(`${target}: expected exactly one gateway server, found ${gateways.length}`);
  const gw = gateways[0].block!;
  const locs = gw.filter((d) => d.name === 'location');
  return {
    main: ds.filter((d) => d.name !== 'http').map((d) => serialize([d], target)),
    http: http.block.filter((d) => d !== gateways[0]).map((d) => serialize([d], target)),
    server: gw.filter((d) => d.name !== 'location').map((d) => serialize([d], target)),
    locations: new Map(locs.map((d) => [d.args.join(' '), serialize(d.block ?? [], target)])),
    regexOrder: locs.filter((d) => d.args[0] === '~' || d.args[0] === '~*').map((d) => d.args.join(' ')),
  };
}

const models = Object.fromEntries(TARGETS.map((t) => [t, model(t)])) as Record<Target, Model>;

/** Items of a scope, keyed so a `map … {` block matches its declared head. */
function itemsOf(t: Target, scope: Scope): string[] {
  return scope === 'location' ? [...models[t].locations.keys()] : models[t][scope];
}

function declaredFor(scope: Scope, item: string) {
  return TARGET_SPECIFIC.find((d) => d.scope === scope && (item === d.item || item.startsWith(`${d.item} {`)));
}

const short = (ts: readonly string[]) => ts.map((t) => t.split('/').pop()).sort();

describe('nginx.conf cross-target drift', () => {
  it.each(['main', 'http', 'server', 'location'] as Scope[])('every %s-level difference is a declared target-specific item', (scope) => {
    const all = new Set(TARGETS.flatMap((t) => itemsOf(t, scope)));
    const undeclared: string[] = [];
    for (const item of all) {
      const carriers = TARGETS.filter((t) => itemsOf(t, scope).includes(item));
      if (carriers.length === TARGETS.length) continue;
      const decl = declaredFor(scope, item);
      if (!decl || short(decl.targets).join() !== short(carriers).join()) {
        undeclared.push(`${item.slice(0, 160)}  — only in [${short(carriers).join(', ')}]${decl ? `, declared for [${short(decl.targets).join(', ')}]` : ''}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('every declared target-specific item still exists in exactly its declared targets', () => {
    const stale = TARGET_SPECIFIC.filter((d) => {
      const carriers = TARGETS.filter((t) => itemsOf(t, d.scope).some((i) => i === d.item || i.startsWith(`${d.item} {`)));
      return short(carriers).join() !== short(d.targets).join();
    }).map((d) => `${d.scope}: ${d.item}`);
    expect(stale).toEqual([]);
  });

  it('every location shared by all targets has the same body (after per-target parameters)', () => {
    const drifted: Record<string, Record<string, string>> = {};
    for (const [key, body] of models[TARGETS[0]].locations) {
      if (!TARGETS.every((t) => models[t].locations.has(key)) || key in LOCATION_BODY_VARIES) continue;
      const bodies = TARGETS.map((t) => models[t].locations.get(key)!);
      if (bodies.some((b) => b !== body)) drifted[key] = Object.fromEntries(TARGETS.map((t, i) => [t, bodies[i]]));
    }
    expect(drifted).toEqual({});
  });

  it('each LOCATION_BODY_VARIES entry really varies (otherwise drop the exemption)', () => {
    for (const key of Object.keys(LOCATION_BODY_VARIES)) {
      const bodies = new Set(TARGETS.map((t) => models[t].locations.get(key)));
      expect({ key, varies: bodies.size > 1, everywhere: !bodies.has(undefined) }).toEqual({ key, varies: true, everywhere: true });
    }
  });

  it('regex locations (first-match-wins) appear in the same order everywhere', () => {
    const common = (t: Target) => models[t].regexOrder.filter((k) => TARGETS.every((u) => models[u].locations.has(k)));
    for (const t of TARGETS.slice(1)) expect({ target: t, order: common(t) }).toEqual({ target: t, order: common(TARGETS[0]) });
  });

  it('streams log export unbuffered on every target', () => {
    // The drift this test was written against: docker-only until 2026-09-21.
    for (const t of TARGETS) {
      const body = models[t].locations.get('~ ^/api/observability/logs/(export|raw|tail)$');
      expect({ t, body }).toEqual({ t, body: expect.stringContaining('proxy_buffering off;') });
    }
  });
});
