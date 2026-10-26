// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The minimal in-cluster Kubernetes client the autoscaling controllers share.
 *
 * DELIBERATELY NOT @kubernetes/client-node. Every caller needs the same two
 * things — a GET and a merge/strategic PATCH against ONE named resource — and
 * the in-pod ServiceAccount already provides the host, the token and the CA.
 * Pulling in a large client tree for that would add supply-chain surface for no
 * capability, in a service that is deliberately the only one holding
 * cluster-write RBAC.
 *
 * WHY IT IS SHARED. `pvc-autoexpand.ts` and `postgres-rung.ts` each carried a
 * byte-identical copy (only the `fetch` call's line wrapping differed). Two
 * copies of the code that mutates cluster state is the wrong kind of
 * duplication: a fix to the token handling, the error shape, or the
 * not-in-a-pod guard would land in one and not the other, and the one that
 * missed it is a controller patching a live database or a live volume.
 *
 * It stays MINIMAL on purpose. No retries, no caching, no resource model: a
 * caller that wants those should be explicit about them, because both current
 * callers are already behind a Redis cooldown and an automatic retry would
 * silently multiply a mutation the cooldown exists to space out.
 */

import { readFile } from 'fs/promises';

/** Where the kubelet projects the pod's ServiceAccount token. */
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface K8sWrite {
  method: string;
  body: string;
  /**
   * `application/merge-patch+json` or
   * `application/strategic-merge-patch+json`. The choice is the caller's and it
   * matters: a plain merge patch REPLACES an array wholesale, so patching one
   * container of a pod template with it deletes the others (the metrics
   * sidecar, typically). Strategic merge honours `containers`' merge key.
   */
  contentType: string;
}

/**
 * One request against the API server, as the pod's ServiceAccount.
 *
 * Throws on any non-2xx with the status and a truncated body, because every
 * caller reports the failure to an operator rather than retrying — a 403 here
 * means the Role is missing a verb, and that message is the whole diagnosis.
 */
export async function k8sRequest(path: string, init?: K8sWrite): Promise<unknown> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || '443';
  // Named explicitly rather than left to a connect error: on the docker target
  // there is no API server at all, and "not running in a Kubernetes pod" is the
  // answer, not a timeout.
  if (!host) throw new Error('not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)');
  const token = await readFile(`${SA_DIR}/token`, 'utf-8');
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.trim()}`,
    accept: 'application/json',
  };
  if (init) headers['content-type'] = init.contentType;
  const res = await fetch(`https://${host}:${port}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body,
  });
  if (!res.ok) {
    throw new Error(`k8s ${init?.method ?? 'GET'} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}
