// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Code, BookOpen, KeyRound } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';

/**
 * Services exposed through the gateway, with the browser-reachable `/api/*`
 * prefix each one serves. Sourced from the nginx gateway route table — these are
 * the paths the SPA (and any developer's tooling) can call from the app origin.
 */
const SERVICES: Array<{ name: string; purpose: string; prefixes: string[] }> = [
  { name: 'Platform', purpose: 'Auth, users, organizations, invitations, RBAC, audit, config', prefixes: ['/api/auth', '/api/user', '/api/users', '/api/organization', '/api/invitation', '/api/audit', '/api/admin', '/api/config'] },
  { name: 'Pipeline', purpose: 'Pipeline CRUD, AI generation, templates, scorecard, registry', prefixes: ['/api/pipeline', '/api/pipelines', '/api/pipeline-templates'] },
  { name: 'Plugin', purpose: 'Plugin CRUD, upload, build queue, AI generation', prefixes: ['/api/plugin', '/api/plugins'] },
  { name: 'Compliance', purpose: 'Rules, policies, exemptions, scans, validation', prefixes: ['/api/compliance'] },
  { name: 'Reporting', purpose: 'Execution reports, analytics, DORA metrics', prefixes: ['/api/reports'] },
  { name: 'Quota', purpose: 'Per-organization resource limits and usage', prefixes: ['/api/quota'] },
  { name: 'Billing', purpose: 'Subscriptions, discounts, promotions, marketplace', prefixes: ['/api/billing'] },
  { name: 'Message', purpose: 'Org-to-org messages and announcements', prefixes: ['/api/messages'] },
  { name: 'Image Registry', purpose: 'Plugin container images and token auth', prefixes: ['/api/images', '/token', '/v2'] },
];

/**
 * In-app API catalog. Surfaces every service reachable through the gateway with
 * its browser-callable `/api/*` prefixes, plus how to authenticate — a single
 * discovery surface for developers integrating with the platform. The full,
 * endpoint-level reference lives in the in-app API Reference help topic and the
 * generated OpenAPI spec each service serves at `/docs/openapi.json`.
 */
export default function ApiCatalogPage() {
  const { user, isReady } = useAuthGuard();
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="API Catalog" subtitle="Services, their gateway routes, and how to call them">
      <div className="page-section space-y-6">
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="w-5 h-5 text-gray-500" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Authentication</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            All endpoints are reached through the gateway under <code>/api/*</code>. Authenticate with a bearer token and scope the request to your organization:
          </p>
          <pre className="mt-2 px-4 py-3 text-xs font-mono rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200 overflow-x-auto">{`Authorization: Bearer <token>
x-org-id: <your-organization-id>`}</pre>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            Create a token on the <Link href="/dashboard/tokens" className="action-link">API Tokens</Link> page. Full endpoint details are in the{' '}
            <Link href="/dashboard/help" className="action-link">API Reference</Link>.
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Code className="w-5 h-5 text-gray-500" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Services</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-4 font-medium">Service</th>
                  <th className="py-2 pr-4 font-medium">Purpose</th>
                  <th className="py-2 font-medium">Gateway routes</th>
                </tr>
              </thead>
              <tbody>
                {SERVICES.map((svc) => (
                  <tr key={svc.name} className="border-b border-gray-100 dark:border-gray-800 align-top">
                    <td className="py-2 pr-4 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{svc.name}</td>
                    <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{svc.purpose}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {svc.prefixes.map((p) => (
                          <code key={p} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-300">{p}</code>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-5 h-5 text-gray-500" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Machine-readable spec</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Each service generates an OpenAPI 3.1 spec from its request schemas, served at <code>/docs/openapi.json</code> on the service
            (with an interactive Swagger UI at <code>/docs</code> in non-production deployments). Point your client generator at those specs, or
            browse the hand-written reference in <Link href="/dashboard/help" className="action-link">Help → API Reference</Link>.
          </p>
        </Card>
      </div>
    </DashboardLayout>
  );
}
