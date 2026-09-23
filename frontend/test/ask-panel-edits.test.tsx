// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Ask panel's CHANGE proposals — edits, org settings and the two
 * remediation kinds that file into an existing approval queue.
 *
 * What these tests hold onto:
 *  - the card shows a CURRENT -> PROPOSED diff, and an unchanged field is absent
 *    from it rather than rendered as an edit;
 *  - a secret-bearing field is never rendered and never committed;
 *  - the commit sends exactly the fields the user saw change — a field the
 *    model slipped in is structurally unappliable;
 *  - a draft whose entity moved since it was rendered is REFUSED, with nothing
 *    written and a message that says so;
 *  - the button is inert without the permission the route wants, including
 *    during a read-only impersonation session;
 *  - a remediation commit FILES A REQUEST rather than applying a change.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { AskPanel } from '../src/components/ask/AskPanel';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

const askAgentStream = jest.fn<AnyFn>();
const getAskProviders = jest.fn<AnyFn>();
const getOrgAIConfig = jest.fn<AnyFn>();
const getPipelineById = jest.fn<AnyFn>();
const updatePipeline = jest.fn<AnyFn>();
const listPluginInstalls = jest.fn<AnyFn>();
const requestInstallChange = jest.fn<AnyFn>();
const createExemption = jest.fn<AnyFn>();
const getIncidentSettings = jest.fn<AnyFn>();
const putReportingSettings = jest.fn<AnyFn>();
const getPluginSecurityNotifications = jest.fn<AnyFn>();
const updatePluginSecurityNotifications = jest.fn<AnyFn>();
const getComplianceNotificationPreference = jest.fn<AnyFn>();
const updateComplianceNotificationPreference = jest.fn<AnyFn>();

jest.mock('@/lib/api-cache', () => ({
  __esModule: true,
  invalidate: { pipelines: jest.fn(), plugins: jest.fn(), organizations: jest.fn() },
}));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    askAgentStream: (...a: unknown[]) => askAgentStream(...a),
    getAskProviders: (...a: unknown[]) => getAskProviders(...a),
    getOrgAIConfig: (...a: unknown[]) => getOrgAIConfig(...a),
    getPipelineById: (...a: unknown[]) => getPipelineById(...a),
    updatePipeline: (...a: unknown[]) => updatePipeline(...a),
    listPluginInstalls: (...a: unknown[]) => listPluginInstalls(...a),
    requestInstallChange: (...a: unknown[]) => requestInstallChange(...a),
    createExemption: (...a: unknown[]) => createExemption(...a),
    getIncidentSettings: (...a: unknown[]) => getIncidentSettings(...a),
    putReportingSettings: (...a: unknown[]) => putReportingSettings(...a),
    getPluginSecurityNotifications: (...a: unknown[]) => getPluginSecurityNotifications(...a),
    updatePluginSecurityNotifications: (...a: unknown[]) => updatePluginSecurityNotifications(...a),
    getComplianceNotificationPreference: (...a: unknown[]) => getComplianceNotificationPreference(...a),
    updateComplianceNotificationPreference: (...a: unknown[]) => updateComplianceNotificationPreference(...a),
  },
}));

async function* gen(events: Array<{ type: string; data?: unknown; message?: string }>) {
  for (const e of events) yield e;
}

function ask(question: string) {
  fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: question } });
  fireEvent.click(screen.getByLabelText('Send'));
}

/** Stream one proposal and settle. */
function propose(data: unknown) {
  askAgentStream.mockReturnValue(gen([{ type: 'proposal', data }, { type: 'done' }]));
}

/** A pipeline edit: the name changes, the description does not. */
const PIPELINE_EDIT = {
  kind: 'pipeline-edit',
  id: 'p1',
  target: 'web-ci',
  provenance: { proposedBy: 'ask-agent' },
  refusedFields: [],
  description: 'Rename it and add a test stage',
  changedFields: ['pipelineName'],
  changedPaths: [],
  current: { pipelineName: 'web-ci', description: 'builds the web app' },
  proposed: { pipelineName: 'web-ci-v2', description: 'builds the web app' },
  commit: { service: 'pipeline', method: 'PUT', path: '/pipelines/:id', permission: 'pipelines:write' },
};

describe('AskPanel edit proposals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGuard({ can: () => true });
    getAskProviders.mockResolvedValue({ data: { providers: [] } });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
  });

  it('renders CURRENT -> PROPOSED for the changed field only', async () => {
    propose(PIPELINE_EDIT);
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('rename web-ci');

    await waitFor(() => expect(screen.getByText('Proposed pipeline change')).toBeInTheDocument());
    const row = await screen.findByTestId('ask-diff-pipelineName');
    expect(row).toHaveTextContent('web-ci');
    expect(row).toHaveTextContent('web-ci-v2');
    // The unchanged field is ABSENT — not greyed out, not listed. An unchanged
    // field that appears in a diff reads as an edit.
    expect(screen.queryByTestId('ask-diff-description')).not.toBeInTheDocument();
  });

  it('commits only the reviewed field — a field the model slipped in is unappliable', async () => {
    propose({
      ...PIPELINE_EDIT,
      // `visibility` differs but is NOT declared in changedFields.
      proposed: { pipelineName: 'web-ci-v2', description: 'builds the web app', visibility: 'public' },
    });
    getPipelineById.mockResolvedValue({ success: true, data: { pipeline: { pipelineName: 'web-ci', description: 'builds the web app' } } });
    updatePipeline.mockResolvedValue({ success: true, data: { pipeline: { id: 'p1' } } });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('rename web-ci');

    await waitFor(() => expect(screen.getByRole('button', { name: /Apply change/i })).toBeEnabled());
    // The undeclared field is called out rather than silently dropped.
    expect(screen.getByTestId('ask-diff-refused')).toHaveTextContent('visibility');

    fireEvent.click(screen.getByRole('button', { name: /Apply change/i }));
    await waitFor(() => expect(updatePipeline).toHaveBeenCalled());
    expect(updatePipeline).toHaveBeenCalledWith('p1', { pipelineName: 'web-ci-v2' });
    await screen.findByText('Applied — open pipelines');
  });

  it('re-reads before committing and REFUSES a draft whose entity moved', async () => {
    propose(PIPELINE_EDIT);
    // Someone renamed it between the draft and the click.
    getPipelineById.mockResolvedValue({ success: true, data: { pipeline: { pipelineName: 'renamed-by-someone-else' } } });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('rename web-ci');

    await waitFor(() => expect(screen.getByRole('button', { name: /Apply change/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Apply change/i }));

    const stale = await screen.findByTestId('ask-stale');
    expect(stale).toHaveTextContent(/changed after the draft was reviewed \(pipelineName\)/i);
    expect(stale).toHaveTextContent(/nothing was applied/i);
    // Refused, not clobbered.
    expect(updatePipeline).not.toHaveBeenCalled();
  });

  it('leaves the card readable but inert without the route\'s permission', async () => {
    mockAuthGuard({ can: (p: string) => p !== 'pipelines:write' });
    propose(PIPELINE_EDIT);

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('rename web-ci');

    await waitFor(() => expect(screen.getByText('Proposed pipeline change')).toBeInTheDocument());
    const apply = screen.getByRole('button', { name: /Apply change/i });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute('title', 'Requires the pipelines:write permission');
    // The diff is still reviewable.
    expect(screen.getByTestId('ask-diff-pipelineName')).toBeInTheDocument();

    fireEvent.click(apply);
    expect(updatePipeline).not.toHaveBeenCalled();
  });
});

describe('AskPanel org-settings proposals', () => {
  /**
   * Keyed by the SHARED allowlist's `<surface>.<field>` keys
   * (`@pipeline-builder/api-core/ask-proposals`) — the browser re-runs that
   * table itself rather than trusting the stream to have done it.
   */
  const ORG_SETTINGS = {
    kind: 'org-settings-edit',
    id: 'org-1',
    target: 'Acme',
    provenance: { proposedBy: 'ask-agent' },
    refusedFields: [],
    current: {
      'pluginSecurityNotifications.notifyRescan': true,
      'pluginSecurityNotifications.digestMode': 'immediate',
      'complianceNotifications.emailEnabled': false,
      'reporting.incidentWindowHours': 24,
    },
    proposed: {
      'pluginSecurityNotifications.notifyRescan': false,
      'pluginSecurityNotifications.digestMode': 'daily',
      'complianceNotifications.emailEnabled': true,
      // Unchanged: must not read as an edit, and must not be sent.
      'reporting.incidentWindowHours': 24,
      // Not on the shared allowlist at all: the injection signal.
      'organization.mfaPolicy': 'optional',
      // A secret the allowlist has no row for — never rendered, never sent.
      'pluginSecurityNotifications.webhookSecret': 'hunter2-please-no',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGuard({ can: () => true });
    getAskProviders.mockResolvedValue({ data: { providers: [] } });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
    getPluginSecurityNotifications.mockResolvedValue({
      success: true,
      data: { preferences: { recipientMode: 'writers', notifyRescan: true, digestMode: 'immediate', webhookUrl: 'https://hook.example/x', hasWebhookSecret: true } },
    });
    getComplianceNotificationPreference.mockResolvedValue({
      success: true,
      data: { preference: { notifyOnBlock: true, notifyOnWarning: false, emailEnabled: false, digestMode: 'immediate', webhookUrl: null, hasWebhookSecret: false } },
    });
    getIncidentSettings.mockResolvedValue({ incidentWindowHours: 24, defaultWindowHours: 24 });
    updatePluginSecurityNotifications.mockResolvedValue({ success: true, data: { preferences: {} } });
    updateComplianceNotificationPreference.mockResolvedValue({ success: true, data: { preference: {} } });
    putReportingSettings.mockResolvedValue({ incidentWindowHours: 24 });
  });

  it('shows only real changes, names them from the shared allowlist, and hides secrets', async () => {
    propose(ORG_SETTINGS);
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('quieten the rescan notices');

    await waitFor(() => expect(screen.getByText('Proposed organization setting')).toBeInTheDocument());
    // Labels come from the shared spec, not from the wire.
    expect(screen.getByTestId('ask-diff-pluginSecurityNotifications.notifyRescan'))
      .toHaveTextContent('Notify on nightly rescan findings');
    // Unchanged → absent. A field that did not move must not read as an edit.
    expect(screen.queryByTestId('ask-diff-reporting.incidentWindowHours')).not.toBeInTheDocument();
    // Off-allowlist keys are counted and named, never rendered as values.
    expect(screen.getByTestId('ask-diff-refused')).toHaveTextContent('organization.mfaPolicy');
    expect(screen.queryByText(/hunter2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hook\.example/)).not.toBeInTheDocument();
  });

  it('sends one request per surface, with only the reviewed fields', async () => {
    propose(ORG_SETTINGS);
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('quieten the rescan notices');

    await waitFor(() => expect(screen.getByRole('button', { name: /Apply setting/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Apply setting/i }));

    await waitFor(() => expect(updatePluginSecurityNotifications).toHaveBeenCalled());
    // `spec.field` is what each API's body calls it; the surface key never leaks.
    expect(updatePluginSecurityNotifications).toHaveBeenCalledWith({ notifyRescan: false, digestMode: 'daily' });
    await waitFor(() => expect(updateComplianceNotificationPreference).toHaveBeenCalledWith({ emailEnabled: true }));
    // The unchanged reporting field means that surface is never written at all.
    expect(putReportingSettings).not.toHaveBeenCalled();
  });

  it('refuses when a setting moved under the draft, and writes nothing', async () => {
    propose(ORG_SETTINGS);
    // Someone turned the rescan notice off already.
    getPluginSecurityNotifications.mockResolvedValue({
      success: true,
      data: { preferences: { recipientMode: 'writers', notifyRescan: false, digestMode: 'immediate', webhookUrl: null, hasWebhookSecret: false } },
    });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('quieten the rescan notices');

    await waitFor(() => expect(screen.getByRole('button', { name: /Apply setting/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Apply setting/i }));

    expect(await screen.findByTestId('ask-stale')).toHaveTextContent(/Notify on nightly rescan findings/);
    expect(updatePluginSecurityNotifications).not.toHaveBeenCalled();
    expect(updateComplianceNotificationPreference).not.toHaveBeenCalled();
  });

  it('reports a partial apply honestly rather than as success', async () => {
    propose(ORG_SETTINGS);
    updateComplianceNotificationPreference.mockRejectedValue(new Error('403 forbidden'));

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('quieten the rescan notices');

    await waitFor(() => expect(screen.getByRole('button', { name: /Apply setting/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Apply setting/i }));

    // One surface landed, the other did not — and the card says so instead of
    // claiming the whole reviewed change was applied.
    const failure = await screen.findByText(/Not applied: compliance notifications/i);
    expect(failure).toHaveTextContent(/Applied 1 of 2/);
    expect(screen.queryByText('Applied — open settings')).not.toBeInTheDocument();
  });

  it('needs every permission the touched surfaces require', async () => {
    // Holds org:settings but not compliance:write — the change spans both.
    mockAuthGuard({ can: (p: string) => p === 'org:settings' });
    propose(ORG_SETTINGS);
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('quieten the rescan notices');

    await waitFor(() => expect(screen.getByText('Proposed organization setting')).toBeInTheDocument());
    const apply = screen.getByRole('button', { name: /Apply setting/i });
    expect(apply).toBeDisabled();
    expect(apply.getAttribute('title')).toMatch(/compliance:write/);
  });
});

/**
 * Phase 2 put the org's own policy in front of the model, so the card must put
 * the verdict in front of the user — above the fold, not behind the review
 * disclosure. A confident draft that the create route will refuse is the thing
 * worth seeing first.
 */
describe('AskPanel policy and validation notes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGuard({ can: () => true });
    getAskProviders.mockResolvedValue({ data: { providers: [] } });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
  });

  it('says when compliance would BLOCK the draft, and names the rule', async () => {
    propose({
      kind: 'pipeline',
      props: { project: 'proj', organization: 'org' },
      provenance: { proposedBy: 'ask-agent' },
      refusedFields: [],
      compliance: {
        checked: true, compliant: false, blocked: true,
        violations: [{ ruleId: 'r1', ruleName: 'require-approval-stage', message: 'Production deploys need a manual approval.' }],
        warnings: [],
      },
    });
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('ship straight to prod');

    const findings = await screen.findByTestId('ask-compliance-findings');
    expect(findings).toHaveTextContent(/Compliance would BLOCK this/);
    expect(findings).toHaveTextContent('require-approval-stage: Production deploys need a manual approval.');
  });

  it('names the dry-run as NOT RUN rather than implying the draft passed', async () => {
    propose({
      kind: 'pipeline',
      props: { project: 'proj', organization: 'org' },
      compliance: { checked: false, compliant: false, blocked: false, violations: [], warnings: [], unavailable: 'the compliance service did not answer' },
    });
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('draft me something');

    expect(await screen.findByTestId('ask-compliance-unchecked'))
      .toHaveTextContent(/Not checked against the organization's compliance rules: the compliance service did not answer/);
  });

  it('shows why a drafted template would be refused by the create route', async () => {
    propose({
      kind: 'template',
      template: { name: 'node-ci', props: {} },
      validation: {
        valid: false,
        errors: [{ field: 'props.stages[0]', message: 'unknown scope root "env"' }],
        cycles: [['a', 'b', 'a']],
        undeclaredVars: ['REGION'],
      },
    });
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('a reusable node template');

    const note = await screen.findByTestId('ask-validation');
    expect(note).toHaveTextContent('unknown scope root "env"');
    expect(note).toHaveTextContent('Reference cycle: a -> b -> a');
    expect(note).toHaveTextContent('Undeclared variables: REGION');
  });
});

describe('AskPanel remediation proposals', () => {
  const INSTALL_CHANGE = {
    kind: 'install-change-request',
    id: 'i1',
    target: 'acme/scanner',
    provenance: { proposedBy: 'ask-agent' },
    refusedFields: [],
    changedFields: ['version'],
    changedPaths: [],
    current: { version: '1.0.0', versionPolicy: 'pinned' },
    proposed: { version: '1.4.2', versionPolicy: 'pinned' },
    note: 'clears CVE-2026-0001',
    commit: { service: 'plugin', method: 'POST', path: '/plugins/installs/:id/change-requests', permission: 'plugins:install' },
  };

  const EXEMPTION = {
    kind: 'compliance-exemption-request',
    target: 'no-root-containers on acme/scanner',
    provenance: { proposedBy: 'ask-agent' },
    refusedFields: [],
    request: { ruleId: 'r1', entityType: 'plugin', entityId: 'pl1', reason: 'vendor image; upstream fix pending' },
    commit: { service: 'compliance', method: 'POST', path: '/compliance/exemptions', permission: 'compliance:read' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGuard({ can: () => true });
    getAskProviders.mockResolvedValue({ data: { providers: [] } });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
  });

  it('files an install change into the approval queue rather than applying it', async () => {
    propose(INSTALL_CHANGE);
    listPluginInstalls.mockResolvedValue({ success: true, data: { installs: [{ id: 'i1', pinnedVersion: '1.0.0', versionPolicy: 'pinned' }] } });
    requestInstallChange.mockResolvedValue({ success: true, data: { changeRequest: {} } });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('upgrade the scanner to clear that CVE');

    // The button and the card say REQUEST, not apply: an approver decides.
    await waitFor(() => expect(screen.getByRole('button', { name: /Request change/i })).toBeEnabled());
    expect(screen.getByTestId('ask-files-request')).toHaveTextContent(/approver decides/i);

    fireEvent.click(screen.getByRole('button', { name: /Request change/i }));
    await waitFor(() => expect(requestInstallChange).toHaveBeenCalled());
    const [id, body] = requestInstallChange.mock.calls[0] as [string, { version: string; note: string }];
    expect(id).toBe('i1');
    expect(body.version).toBe('1.4.2');
    // Provenance reaches the approver in the note they already read.
    expect(body.note).toContain('clears CVE-2026-0001');
    expect(body.note).toContain('ask-agent');
    await screen.findByText('Requested — open installs');
  });

  it('refuses the install request when the install already moved', async () => {
    propose(INSTALL_CHANGE);
    listPluginInstalls.mockResolvedValue({ success: true, data: { installs: [{ id: 'i1', pinnedVersion: '1.2.0', versionPolicy: 'pinned' }] } });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('upgrade the scanner');

    await waitFor(() => expect(screen.getByRole('button', { name: /Request change/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Request change/i }));

    expect(await screen.findByTestId('ask-stale')).toHaveTextContent(/version/);
    expect(requestInstallChange).not.toHaveBeenCalled();
  });

  it('files an exemption REQUEST with the reviewed body', async () => {
    propose(EXEMPTION);
    createExemption.mockResolvedValue({ success: true, data: { exemption: { id: 'e1' } } });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('we cannot fix that root container yet');

    await waitFor(() => expect(screen.getByRole('button', { name: /Request exemption/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Request exemption/i }));

    await waitFor(() => expect(createExemption).toHaveBeenCalled());
    const body = createExemption.mock.calls[0][0] as { ruleId: string; entityId: string; reason: string };
    expect(body).toMatchObject({ ruleId: 'r1', entityId: 'pl1' });
    expect(body.reason).toContain('upstream fix pending');
    expect(body.reason).toContain('ask-agent');
  });

  it('a read-only impersonation session cannot file a request, even behind a READ permission', async () => {
    // `compliance:read` is not a mutation permission, so `can()` alone would let
    // this through — every commit here is a write, so the session check applies.
    mockAuthGuard({ can: () => true, isReadOnly: true });
    propose(EXEMPTION);

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('request an exemption');

    await waitFor(() => expect(screen.getByText('Proposed compliance exemption')).toBeInTheDocument());
    const request = screen.getByRole('button', { name: /Request exemption/i });
    expect(request).toBeDisabled();
    fireEvent.click(request);
    expect(createExemption).not.toHaveBeenCalled();
  });
});
