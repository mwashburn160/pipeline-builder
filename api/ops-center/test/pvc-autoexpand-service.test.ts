// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `expandClaim` — the Kubernetes actuator behind PVC auto-expansion — with the
 * k8s client, Redis and metrics stubbed and the decision logic real.
 *
 * Pins: disabled is a no-op; no Redis fails CLOSED; the cooldown is an atomic
 * SET NX per claim; a manual-binding claim (no storageClassName) is refused
 * rather than patched into a no-op; an unreadable request is an error; the
 * ceiling is measured from the pinned ORIGINAL annotation (written once) and the
 * maxGi cap; the patch is a merge-patch on exactly that claim's path (namespace
 * and name URL-encoded); a StatefulSet claim raises template drift; and an API
 * failure releases the cooldown, since nothing was modified.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const k8s = jest.fn<(path: string, init?: { method?: string; contentType?: string; body?: string }) => Promise<unknown>>();
jest.unstable_mockModule('../src/utils/k8s-client.js', () => ({ k8sRequest: (p: string, i?: never) => k8s(p, i) }));

const redis = {
  set: jest.fn<(...a: unknown[]) => Promise<string | null>>(),
  del: jest.fn<(...a: unknown[]) => Promise<number>>(),
};
let redisAvailable = true;
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: async () => (redisAvailable ? redis : null),
}));

const mockIncCounter = jest.fn();
const mockSetGauge = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  setGauge: (...a: unknown[]) => mockSetGauge(...a),
  observe: jest.fn(),
}));

const { expandClaim, ORIGINAL_ANNOTATION, LAST_ANNOTATION, reconcileTemplateDrift, statefulSetOfClaim } = await import('../src/services/pvc-autoexpand.js');

const CFG = { enabled: true, stepFactor: 1.5, ceilingFactor: 4, maxGi: 500, cooldownSeconds: 21600 };

const pvc = (over: { storage?: string; sc?: string | null; annotations?: Record<string, string> } = {}) => ({
  metadata: { annotations: over.annotations ?? {} },
  spec: {
    ...(over.sc === null ? {} : { storageClassName: over.sc ?? 'gp3' }),
    resources: { requests: { storage: over.storage ?? '20Gi' } },
  },
});

beforeEach(() => {
  k8s.mockReset();
  redisAvailable = true;
  redis.set.mockReset().mockResolvedValue('OK');
  redis.del.mockReset().mockResolvedValue(1);
  mockIncCounter.mockReset();
  mockSetGauge.mockReset();
});

const results = () => mockIncCounter.mock.calls.map((c) => (c[1] as { result: string }).result);

describe('refusals before the API is touched', () => {
  it('disabled: nothing happens', async () => {
    expect(await expandClaim('pb', 'data-postgres-0', { ...CFG, enabled: false })).toMatchObject({ outcome: 'disabled' });
    expect(redis.set).not.toHaveBeenCalled();
    expect(k8s).not.toHaveBeenCalled();
  });

  it('no Redis: fails CLOSED', async () => {
    redisAvailable = false;
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/Redis unavailable/) });
    expect(k8s).not.toHaveBeenCalled();
  });

  it('within the cooldown (SET NX lost): no read, no patch', async () => {
    redis.set.mockResolvedValue(null);
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'cooldown' });
    expect(redis.set).toHaveBeenCalledWith('pvc:autoexpand:pb/c', expect.any(String), 'EX', 21600, 'NX');
    expect(k8s).not.toHaveBeenCalled();
  });
});

describe('expansion', () => {
  it('first expansion: merge-patches the request up one step and pins the original size', async () => {
    k8s.mockResolvedValueOnce(pvc()).mockResolvedValueOnce({});
    const out = await expandClaim('pb', 'data-postgres-0', CFG);
    expect(out).toEqual({ namespace: 'pb', claim: 'data-postgres-0', outcome: 'expanded', fromGi: 20, toGi: 30 });

    expect(k8s).toHaveBeenCalledTimes(2);
    const [path, init] = k8s.mock.calls[1];
    expect(path).toBe('/api/v1/namespaces/pb/persistentvolumeclaims/data-postgres-0');
    expect(init).toMatchObject({ method: 'PATCH', contentType: 'application/merge-patch+json' });
    const patch = JSON.parse(init!.body!);
    expect(patch.spec).toEqual({ resources: { requests: { storage: '30Gi' } } });
    expect(patch.metadata.annotations[ORIGINAL_ANNOTATION]).toBe('20Gi');
    expect(patch.metadata.annotations[LAST_ANNOTATION]).toEqual(expect.any(String));

    expect(results()).toEqual(['expanded']);
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_at_ceiling', { namespace: 'pb', claim: 'data-postgres-0' }, 0);
    expect(mockSetGauge).not.toHaveBeenCalledWith('pvc_autoexpand_template_drift', expect.anything(), 1);
    // The cooldown is held after a real modification.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('a later expansion measures from the pinned original and does not re-pin it', async () => {
    k8s.mockResolvedValueOnce(pvc({ storage: '60Gi', annotations: { [ORIGINAL_ANNOTATION]: '20Gi' } })).mockResolvedValueOnce({});
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'expanded', fromGi: 60, toGi: 80 });
    const patch = JSON.parse(k8s.mock.calls[1][1]!.body!);
    expect(patch.metadata.annotations).not.toHaveProperty(ORIGINAL_ANNOTATION);
  });

  it('URL-encodes the namespace and claim into the API path (no path injection)', async () => {
    k8s.mockResolvedValueOnce(pvc()).mockResolvedValueOnce({});
    await expandClaim('pb/../kube-system', 'x?y', CFG);
    expect(k8s.mock.calls[0][0]).toBe('/api/v1/namespaces/pb%2F..%2Fkube-system/persistentvolumeclaims/x%3Fy');
  });

  it.each(['data-rustfs-0', 'data-redis-2', 'postgres-replica-data-postgres-replica-1'])('a StatefulSet claim (%s) raises template drift', async (claim) => {
    k8s.mockResolvedValueOnce(pvc()).mockResolvedValueOnce({});
    await expandClaim('pb', claim, CFG);
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'pb', claim }, 1);
  });
});

describe('safety limits', () => {
  it('at the factor ceiling: refuses, raises the at-ceiling gauge, never patches', async () => {
    k8s.mockResolvedValueOnce(pvc({ storage: '80Gi', annotations: { [ORIGINAL_ANNOTATION]: '20Gi' } }));
    const out = await expandClaim('pb', 'c', CFG);
    expect(out).toMatchObject({ outcome: 'at-ceiling', fromGi: 80, detail: expect.stringContaining('80Gi ceiling') });
    expect(k8s).toHaveBeenCalledTimes(1);
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_at_ceiling', { namespace: 'pb', claim: 'c' }, 1);
  });

  it('the absolute maxGi caps the step even when the factor would allow more', async () => {
    k8s.mockResolvedValueOnce(pvc({ storage: '400Gi', annotations: { [ORIGINAL_ANNOTATION]: '200Gi' } })).mockResolvedValueOnce({});
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'expanded', toGi: 500 });
    k8s.mockReset().mockResolvedValueOnce(pvc({ storage: '500Gi', annotations: { [ORIGINAL_ANNOTATION]: '200Gi' } }));
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'at-ceiling' });
  });

  it.each([[null], ['']])('a claim with storageClassName=%p (manual hostPath binding) is not-expandable', async (sc) => {
    k8s.mockResolvedValueOnce(pvc({ sc: sc as string | null }));
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'not-expandable' });
    expect(k8s).toHaveBeenCalledTimes(1);
  });

  it.each(['lots', '0Gi'])('an unreadable / zero request (%s) is an error, never a guess', async (storage) => {
    k8s.mockResolvedValueOnce(pvc({ storage }));
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'error', detail: expect.stringContaining('unreadable storage request') });
    expect(k8s).toHaveBeenCalledTimes(1);
  });

  it('a garbage original annotation falls back to the current size as the base', async () => {
    k8s.mockResolvedValueOnce(pvc({ storage: '20Gi', annotations: { [ORIGINAL_ANNOTATION]: 'garbage' } })).mockResolvedValueOnce({});
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'expanded', toGi: 30 });
  });
});

describe('API failures', () => {
  it('a failed read releases the cooldown (nothing was modified)', async () => {
    k8s.mockRejectedValueOnce(new Error('k8s GET /api/v1/... -> 403 forbidden'));
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'error', detail: expect.stringContaining('403') });
    expect(redis.del).toHaveBeenCalledWith('pvc:autoexpand:pb/c');
  });

  it('a rejected patch releases the cooldown, and a failing release does not mask the result', async () => {
    k8s.mockResolvedValueOnce(pvc()).mockRejectedValueOnce(new Error('k8s PATCH -> 422 forbidden: only dynamically provisioned pvc can be resized'));
    redis.del.mockRejectedValue(new Error('redis gone'));
    expect(await expandClaim('pb', 'c', CFG)).toMatchObject({ outcome: 'error', detail: expect.stringContaining('422') });
    expect(results()).toEqual(['error']);
  });
});

describe('statefulSetOfClaim', () => {
  it('maps a templated claim to its StatefulSet, and nothing else', () => {
    expect(statefulSetOfClaim('data-rustfs-3')).toEqual({ statefulSet: 'rustfs', template: 'data', ordinal: 3 });
    expect(statefulSetOfClaim('data-redis-0')).toEqual({ statefulSet: 'redis', template: 'data', ordinal: 0 });
    expect(statefulSetOfClaim('postgres-replica-data-postgres-replica-1'))
      .toEqual({ statefulSet: 'postgres-replica', template: 'postgres-replica-data', ordinal: 1 });
    for (const c of ['postgres-data', 'data-rustfs-', 'data-rustfs-x', 'data-other-0', 'grafana-data']) expect(statefulSetOfClaim(c)).toBeNull();
  });
});

describe('reconcileTemplateDrift (gauge derived from the cluster)', () => {
  const sts = (replicas: number, template: string, storage: string) => ({
    spec: { replicas, volumeClaimTemplates: [{ metadata: { name: template }, spec: { resources: { requests: { storage } } } }] },
  });
  const notFound = (path: string) => new Error(`k8s GET ${path} -> 404 {"kind":"Status"}`);
  /** Route GETs by path; anything unlisted is a 404. */
  const cluster = (objects: Record<string, unknown>) => k8s.mockImplementation(async (path: string) => {
    for (const [suffix, body] of Object.entries(objects)) if (path.endsWith(suffix)) return body;
    throw notFound(path);
  });

  it('publishes 1 for a claim larger than its template and 0 for one that matches', async () => {
    cluster({
      '/statefulsets/rustfs': sts(2, 'data', '20Gi'),
      '/persistentvolumeclaims/data-rustfs-0': pvc({ storage: '30Gi' }),
      '/persistentvolumeclaims/data-rustfs-1': pvc({ storage: '20Gi' }),
    });
    const r = await reconcileTemplateDrift('pb');
    expect(r.map((x) => [x.claim, x.drift])).toEqual([['data-rustfs-0', true], ['data-rustfs-1', false]]);
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'pb', claim: 'data-rustfs-0' }, 1);
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'pb', claim: 'data-rustfs-1' }, 0);
  });

  it('clears the gauge once the StatefulSet is recreated with the new size', async () => {
    cluster({ '/statefulsets/rustfs': sts(1, 'data', '30Gi'), '/persistentvolumeclaims/data-rustfs-0': pvc({ storage: '30Gi' }) });
    await reconcileTemplateDrift('pb');
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'pb', claim: 'data-rustfs-0' }, 0);
  });

  it('covers postgres-replica, whose claims are named after their own template', async () => {
    cluster({
      '/statefulsets/postgres-replica': sts(1, 'postgres-replica-data', '20Gi'),
      '/persistentvolumeclaims/postgres-replica-data-postgres-replica-0': pvc({ storage: '30Gi' }),
    });
    const r = await reconcileTemplateDrift('pb');
    expect(r).toEqual([expect.objectContaining({ claim: 'postgres-replica-data-postgres-replica-0', statefulSet: 'postgres-replica', drift: true })]);
  });

  it('skips a StatefulSet the target does not run and a claim not yet provisioned, without warning', async () => {
    cluster({ '/statefulsets/rustfs': sts(2, 'data', '20Gi'), '/persistentvolumeclaims/data-rustfs-0': pvc({ storage: '20Gi' }) });
    const r = await reconcileTemplateDrift('pb');
    expect(r.map((x) => x.claim)).toEqual(['data-rustfs-0']);
  });

  it('leaves a claim\'s gauge untouched when the API errors (never guesses 0)', async () => {
    k8s.mockImplementation(async (path: string) => {
      if (path.endsWith('/statefulsets/rustfs')) return sts(1, 'data', '20Gi');
      if (path.endsWith('/persistentvolumeclaims/data-rustfs-0')) throw new Error(`k8s GET ${path} -> 403 forbidden`);
      throw notFound(path);
    });
    await expect(reconcileTemplateDrift('pb')).resolves.toEqual([]);
    expect(mockSetGauge).not.toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'gone', claim: 'data-rustfs-0' }, expect.anything());
    expect(mockSetGauge).not.toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'pb', claim: 'data-rustfs-0' }, expect.anything());
  });

  it('zeroes a series it published once the claim or its StatefulSet is gone (a 404 is not drift)', async () => {
    cluster({ '/statefulsets/redis': sts(1, 'data', '20Gi'), '/persistentvolumeclaims/data-redis-0': pvc({ storage: '30Gi' }) });
    await reconcileTemplateDrift('gone');
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'gone', claim: 'data-redis-0' }, 1);
    mockSetGauge.mockReset();
    cluster({});
    await reconcileTemplateDrift('gone');
    expect(mockSetGauge).toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'gone', claim: 'data-redis-0' }, 0);
  });

  it('still checks a published claim after its StatefulSet scaled below its ordinal', async () => {
    cluster({ '/statefulsets/redis': sts(2, 'data', '20Gi'), '/persistentvolumeclaims/data-redis-1': pvc({ storage: '30Gi' }) });
    await reconcileTemplateDrift('scaled');
    mockSetGauge.mockReset();
    cluster({ '/statefulsets/redis': sts(1, 'data', '20Gi'), '/persistentvolumeclaims/data-redis-1': pvc({ storage: '30Gi' }) });
    const r = await reconcileTemplateDrift('scaled');
    expect(r).toEqual([expect.objectContaining({ claim: 'data-redis-1', drift: true })]);
    expect(mockSetGauge).not.toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'scaled', claim: 'data-redis-1' }, 0);
  });

  it('keeps a published series when its StatefulSet is unreadable this sweep', async () => {
    cluster({ '/statefulsets/redis': sts(1, 'data', '20Gi'), '/persistentvolumeclaims/data-redis-0': pvc({ storage: '30Gi' }) });
    await reconcileTemplateDrift('flaky');
    mockSetGauge.mockReset();
    k8s.mockImplementation(async (path: string) => {
      if (path.endsWith('/statefulsets/redis')) throw new Error(`k8s GET ${path} -> 403 forbidden`);
      throw notFound(path);
    });
    await reconcileTemplateDrift('flaky');
    expect(mockSetGauge).not.toHaveBeenCalledWith('pvc_autoexpand_template_drift', { namespace: 'flaky', claim: 'data-redis-0' }, expect.anything());
  });
});
