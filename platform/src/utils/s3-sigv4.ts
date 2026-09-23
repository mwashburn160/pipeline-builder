// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal S3-compatible object client (PUT / GET) signed with AWS SigV4.
 *
 * Platform needs exactly two object operations — write an exported audit
 * chain head (with Object Lock headers) and read it back on verify — so this
 * is a ~100-line signer over `fetch` rather than a new SDK dependency. Path-
 * style addressing (`<endpoint>/<bucket>/<key>`), which both MinIO and S3
 * accept. Credentials are the static, bucket-scoped keys every deploy target
 * already provisions for its MinIO buckets.
 */

import { createHash, createHmac } from 'crypto';

export interface S3Target {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encode an object path, keeping `/` separators. */
function encodeS3Path(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

export interface SignInput {
  method: string;
  /** Absolute URL (host + already-encoded path + optional query). */
  url: string;
  /** Request headers to sign (names case-insensitive). `host`, `x-amz-date` and
   *  `x-amz-content-sha256` are added. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now?: Date;
}

/** Produce the full signed header set (incl. `authorization`) for a request. */
export function signV4(input: SignInput): Record<string, string> {
  const u = new URL(input.url);
  const service = input.service ?? 's3';
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = u.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = input.payloadHash;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [
    input.method.toUpperCase(),
    u.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function objectUrl(t: S3Target, key: string): string {
  return `${t.endpoint.replace(/\/+$/, '')}/${uriEncode(t.bucket)}/${encodeS3Path(key)}`;
}

/** PUT an object. `extraHeaders` carries e.g. the Object Lock headers. Throws on non-2xx. */
export async function s3PutObject(
  t: S3Target,
  key: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const url = objectUrl(t, key);
  const payload = Buffer.from(body, 'utf-8');
  const headers = signV4({
    method: 'PUT',
    url,
    headers: {
      'content-type': 'application/json',
      // Object Lock PUTs require an integrity header; Content-MD5 is accepted
      // by both S3 and MinIO.
      'content-md5': createHash('md5').update(payload).digest('base64'),
      ...extraHeaders,
    },
    payloadHash: sha256Hex(payload),
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
    region: t.region,
  });
  delete headers.host; // fetch sets Host itself
  const res = await fetch(url, { method: 'PUT', headers, body: payload });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 PUT ${key} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** GET an object's body as text; `null` on 404. Throws on any other non-2xx. */
export async function s3GetObject(t: S3Target, key: string): Promise<string | null> {
  const url = objectUrl(t, key);
  const headers = signV4({
    method: 'GET',
    url,
    headers: {},
    payloadHash: sha256Hex(''),
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
    region: t.region,
  });
  delete headers.host;
  const res = await fetch(url, { method: 'GET', headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 GET ${key} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.text();
}
