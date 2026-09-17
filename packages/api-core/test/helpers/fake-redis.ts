// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory Redis stand-in for the SSE ticket store and `incrWindow`.
 *
 * `eval` recognizes the two scripts api-core ships and reproduces their effect
 * in JS (one call = one atomic step, like Redis). The Lua itself is exercised by
 * the opt-in real-Redis suites (API_CORE_TEST_REDIS_URL).
 */
export function makeFakeRedis() {
  const strings = new Map<string, { value: string; expiresAt: number }>();
  const zsets = new Map<string, Map<string, number>>();
  const zsetExpiry = new Map<string, number>();
  const calls: string[] = [];

  const liveString = (key: string) => {
    const e = strings.get(key);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) { strings.delete(key); return null; }
    return e;
  };
  const zset = (key: string) => {
    const exp = zsetExpiry.get(key);
    if (exp !== undefined && Date.now() >= exp) { zsets.delete(key); zsetExpiry.delete(key); }
    let z = zsets.get(key);
    if (!z) { z = new Map(); zsets.set(key, z); }
    return z;
  };

  return {
    calls,
    strings,
    async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
      calls.push('eval');
      if (script.includes('ZCARD')) {
        const [totalKey, orgKey, ticketKey, ttl, maxTotal, maxPerOrg, ticketId, record] = args.map(String);
        const now = Date.now();
        for (const k of [totalKey, orgKey]) {
          const z = zset(k);
          for (const [m, score] of z) if (score <= now) z.delete(m);
        }
        if (zset(totalKey).size >= Number(maxTotal)) return 'total';
        if (zset(orgKey).size >= Number(maxPerOrg)) return 'org';
        strings.set(ticketKey, { value: record, expiresAt: now + Number(ttl) });
        zset(totalKey).set(ticketId, now + Number(ttl));
        zset(orgKey).set(ticketId, now + Number(ttl));
        zsetExpiry.set(totalKey, now + Number(ttl));
        zsetExpiry.set(orgKey, now + Number(ttl));
        return 'ok';
      }
      if (script.includes('INCR')) {
        const [key, windowMs] = args.map(String);
        const e = liveString(key);
        const n = (e ? Number(e.value) : 0) + 1;
        strings.set(key, { value: String(n), expiresAt: e && n !== 1 ? e.expiresAt : Date.now() + Number(windowMs) });
        return n;
      }
      throw new Error('fake-redis: unknown script');
    },
    async getdel(key: string): Promise<string | null> {
      calls.push('getdel');
      const e = liveString(key);
      strings.delete(key);
      return e ? e.value : null;
    },
    async get(key: string): Promise<string | null> {
      calls.push('get');
      return liveString(key)?.value ?? null;
    },
    async set(key: string, value: string, ...args: (string | number)[]): Promise<string> {
      calls.push('set');
      const px = args.findIndex((a) => String(a).toUpperCase() === 'PX');
      const ttl = px >= 0 ? Number(args[px + 1]) : Number.POSITIVE_INFINITY;
      strings.set(key, { value, expiresAt: Date.now() + ttl });
      return 'OK';
    },
    async zrem(key: string, ...members: string[]): Promise<number> {
      calls.push('zrem');
      const z = zset(key);
      let n = 0;
      for (const m of members) if (z.delete(m)) n++;
      return n;
    },
  };
}
