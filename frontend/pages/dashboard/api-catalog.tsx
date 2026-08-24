// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Code, BookOpen, KeyRound } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SectionCard } from '@/components/ui/SectionCard';
import { CodeBlock, EndpointChip } from '@/components/ui/CodeBlock';
import { DataTable, type Column } from '@/components/ui/DataTable';

interface ServiceRow { name: string; purpose: string; prefixes: string[] }

/**
 * Services exposed through the gateway, with the browser-reachable `/api/*`
 * prefix each one serves. Sourced from the nginx gateway route table — these are
 * the paths the SPA (and any developer's tooling) can call from the app origin.
 */
const SERVICES: ServiceRow[] = [
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
const SERVICE_COLUMNS: Column<ServiceRow>[] = [
  { id: 'name', header: 'Service', cellClassName: 'font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap align-top', render: (svc) => svc.name },
  { id: 'purpose', header: 'Purpose', cellClassName: 'text-gray-600 dark:text-gray-300 align-top', render: (svc) => svc.purpose },
  {
    id: 'routes',
    header: 'Gateway routes',
    cellClassName: 'align-top',
    render: (svc) => (
      <div className="flex flex-wrap gap-1">
        {svc.prefixes.map((p) => <EndpointChip key={p}>{p}</EndpointChip>)}
      </div>
    ),
  },
];

export default function ApiCatalogPage() {
  const { user, isReady } = useAuthGuard();
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="API Catalog" subtitle="Services, their gateway routes, and how to call them">
      <div className="space-y-6">
        <SectionCard icon={KeyRound} title="Authentication">
          <p className="text-sm text-[var(--pb-text-muted)]">
            All endpoints are reached through the gateway under <EndpointChip>/api/*</EndpointChip>. Authenticate with a bearer token and scope the request to your organization:
          </p>
          <CodeBlock className="mt-3" language="http" code={'Authorization: Bearer <token>\nx-org-id: <your-organization-id>'} />
          <p className="mt-3 text-sm text-[var(--pb-text-muted)]">
            Create a token on the <Link href="/dashboard/tokens" className="action-link">API Tokens</Link> page. Full endpoint details are in the{' '}
            <Link href="/dashboard/help" className="action-link">API Reference</Link>.
          </p>
        </SectionCard>

        <SectionCard icon={Code} title="Services" bodyClassName="p-0">
          <div className="overflow-x-auto p-5">
            <DataTable
              data={SERVICES}
              columns={SERVICE_COLUMNS}
              isLoading={false}
              animated={false}
              getRowKey={(svc) => svc.name}
              emptyState={{ icon: Code, title: 'No services', description: 'No gateway services are configured.' }}
            />
          </div>
        </SectionCard>

        <SectionCard icon={BookOpen} title="Machine-readable spec">
          <p className="text-sm text-[var(--pb-text-muted)]">
            Each service generates an OpenAPI 3.1 spec from its request schemas, served at <EndpointChip>/docs/openapi.json</EndpointChip> on the service
            (with an interactive Swagger UI at <EndpointChip>/docs</EndpointChip> in non-production deployments). Point your client generator at those specs, or
            browse the hand-written reference in <Link href="/dashboard/help" className="action-link">Help → API Reference</Link>.
          </p>
        </SectionCard>
      </div>
    </DashboardLayout>
  );
}
