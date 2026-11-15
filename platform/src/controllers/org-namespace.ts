// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org k8s namespace manifest render endpoint (sysadmin-only).
 *
 *   GET /api/admin/orgs/:orgId/k8s-namespace.yaml
 *
 * Returns a fully-templated YAML document for the org's namespace +
 * RBAC + NetworkPolicy allowlist + ResourceQuota + LimitRange. The
 * operator pipes the response to `kubectl apply -f -`.
 *
 * Render-only by design — the platform pod doesn't carry cluster-admin
 * credentials so applying server-side would either (a) require a
 * platform-side k8s client + ServiceAccount with the right RBAC bindings,
 * or (b) silently fail when running outside k8s (e.g. local docker-compose
 * dev). The render endpoint gives operators a one-step "I have a new
 * enterprise customer, give me the YAML" surface without forcing the
 * server to grow cluster-write privileges.
 *
 * The rendered document mirrors the templates checked into
 * `deploy/{local/minikube,aws/ec2,aws/eks}/k8s/per-org/` (identical copies);
 * test/org-namespace-template.test.ts fails when the two drift (the renderer
 * lives in helpers/org-namespace-manifest.ts). The templates
 * are the canonical reference; this controller is the served-from-API form.
 */

import { createLogger, sendError } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requirePlatformPermission, withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { renderManifest } from '../helpers/org-namespace-manifest.js';
import { isValidK8sNamespaceName, orgNamespaceName } from '../helpers/org-slug.js';
import { Organization } from '../models/index.js';

const logger = createLogger('org-namespace-controller');

/**
 * Render the per-org namespace YAML. Sysadmin-gated; emits an audit
 * event so operator-driven provisioning is traceable.
 */
export const renderOrgNamespace = withController('Render org k8s namespace', async (req, res) => {
  if (!requirePlatformPermission(req, res, 'platform:read')) return;
  const orgId = String(req.params.orgId);

  const org = await Organization.findById(toOrgId(orgId)).select('slug name').lean();
  if (!org) return sendError(res, 404, 'Organization not found');

  const slug = (org as { slug?: string }).slug;
  const nsName = slug ? orgNamespaceName(slug) : '';
  if (!slug || !isValidK8sNamespaceName(nsName)) {
    // The whole namespace name must be a DNS-1123 label (≤63 chars), not just
    // the slug — refuse rather than emit a manifest kubectl would reject.
    return sendError(res, 400, `Org slug "${slug ?? ''}" does not yield a valid k8s namespace name`);
  }

  const createdAt = new Date().toISOString();
  const yaml = renderManifest({ slug, nsName, createdAt });

  audit(req, 'admin.org.namespace.render', {
    targetType: 'org-namespace',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { namespace: nsName },
  });

  res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nsName}.yaml"`);
  res.status(200).send(yaml);
  logger.info('Rendered per-org namespace manifest', { orgId, namespace: nsName, bytes: yaml.length });
});
