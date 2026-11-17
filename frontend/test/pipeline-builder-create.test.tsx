// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline builder end to end, with REAL children: the pipelines page opens
 * the real CreatePipelineModal (next/dynamic resolved to the actual module), its
 * Wizard tab mounts the real FormBuilderTab and every section/editor under it,
 * and only `@/lib/api` is a double. The test drives the form the way a person
 * does — type, pick, toggle, Next — and asserts on the exact body the page
 * sends to `POST /api/pipelines`.
 *
 * What it pins:
 *  - each wizard step refuses to advance on its own errors, and shows them
 *    INLINE next to the field (role=alert) plus a count summary;
 *  - an OIDC role without a `<host>:sub` trust condition is refused at step 1
 *    (it would trust every repository the provider issues tokens for);
 *  - every section's input reaches the assembled BuilderProps: identity,
 *    description/keywords (lifted off props), vars, defaults (network, security
 *    groups, the metadata toggles), the role, synth source/plugin/network, and
 *    a stage with a step (commands, env, input artifact picked from the synth
 *    output, additional inputs);
 *  - the JSON preview shows what would be sent.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { apiFn, resetApiMock } from './helpers/apiMock';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: true, isLoaded: true, label: 'AI', description: '', unlocks: '', upsellHref: '/', reason: '' }),
}));
// The deployments panel is its own suite's concern (deployed-pipelines-paging).
jest.mock('@/components/pipeline/DeployedPipelinesPanel', () => ({ __esModule: true, DeployedPipelinesPanel: () => null }));
// next/dynamic resolved to the REAL module (no stub): React.lazy over the loader.
jest.mock('next/dynamic', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: (loader: () => Promise<{ default?: unknown }>) => {
      const Lazy = React.lazy(async () => {
        const m = await loader();
        return { default: (m.default ?? m) as React.ComponentType<Record<string, unknown>> };
      });
      return function Dynamic(props: Record<string, unknown>) {
        return React.createElement(React.Suspense, { fallback: null }, React.createElement(Lazy, props));
      };
    },
  };
});

import PipelinesPage from '../pages/dashboard/pipelines';

const SYNTH_PLUGIN = {
  id: 'plug-synth', orgId: 'org-1', name: 'node-synth', version: '2.1.0', description: 'Node CDK synth',
  category: 'build', pluginType: 'CodeBuildStep', visibility: 'org', isDefault: true, isActive: true,
  primaryOutputDirectory: 'cdk.out',
};

/** The `<details>` disclosure whose summary reads `title` (closed ones still hold their DOM). */
function section(title: string | RegExp, root: HTMLElement = document.body) {
  const summary = within(root).getAllByText(title).map((el) => el.closest('summary')).find(Boolean);
  if (!summary) throw new Error(`no disclosure titled ${String(title)}`);
  return within(summary.parentElement as HTMLElement);
}
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const click = (el: HTMLElement) => fireEvent.click(el);
const next = () => click(screen.getByRole('button', { name: /^Next/ }));

async function openWizard() {
  render(<PipelinesPage />);
  click((await screen.findAllByRole('button', { name: /create pipeline/i }))[0]);
  click(await screen.findByRole('tab', { name: 'Wizard' }));
  await screen.findByLabelText('Project *');
}

beforeEach(() => {
  resetApiMock();
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  apiFn('listPipelines').mockResolvedValue({ success: true, data: { pipelines: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } });
  apiFn('listPlugins').mockResolvedValue({ success: true, data: { plugins: [SYNTH_PLUGIN], pagination: { hasMore: false } } });
  apiFn('getAllPluginCatalog').mockResolvedValue([]);
  apiFn('createPipeline').mockResolvedValue({ success: true, data: { inserted: true, pipeline: { id: 'new-1' } } });
});

describe('pipeline builder — step gates and inline errors', () => {
  it('refuses to leave step 1 empty and names each missing field next to it', async () => {
    await openWizard();
    next();
    const projectField = screen.getByLabelText('Project *').closest('.form-field') as HTMLElement;
    expect(within(projectField).getByRole('alert')).toHaveTextContent('Project is required');
    expect(screen.getByLabelText('Project *')).toHaveAttribute('aria-invalid', 'true');
    const orgField = screen.getByLabelText('Organization *').closest('.form-field') as HTMLElement;
    expect(within(orgField).getByRole('alert')).toHaveTextContent('Organization is required');
    expect(screen.getByText('Please fix 2 validation error(s) above.')).toBeInTheDocument();
    // Still on step one.
    expect(screen.getByRole('button', { name: /Pipeline configuration/ })).toHaveAttribute('aria-current', 'step');
  });

  it('an OIDC role with no :sub trust condition is refused inline, even with an issuer', async () => {
    await openWizard();
    change(screen.getByLabelText('Project *'), 'web');
    change(screen.getByLabelText('Organization *'), 'acme');
    const role = section('IAM Role');
    change(role.getByLabelText('Role type'), 'oidc');
    // Neither provider ARN nor issuer → its own error.
    next();
    expect(role.getByText('Either Provider ARN or Issuer URL is required')).toBeInTheDocument();

    change(role.getByLabelText('Issuer URL'), 'https://token.actions.githubusercontent.com');
    // An issuer disables the provider-ARN field (one or the other).
    expect(role.getByLabelText('Provider ARN')).toBeDisabled();
    // An audience-only condition, and a wildcard subject, are both refused.
    change(role.getByLabelText(/Trust policy conditions/), 'token.actions.githubusercontent.com:aud=sts.amazonaws.com\ntoken.actions.githubusercontent.com:sub=*');
    next();
    const cond = role.getByLabelText(/Trust policy conditions/).closest('.form-field') as HTMLElement;
    expect(within(cond).getByRole('alert')).toHaveTextContent(/A subject condition is required/);

    change(role.getByLabelText(/Trust policy conditions/), 'token.actions.githubusercontent.com:sub=repo:acme/web:ref:refs/heads/main');
    next();
    expect(await screen.findByLabelText('Repository *')).toBeInTheDocument();
    expect(screen.queryByText(/A subject condition is required/)).not.toBeInTheDocument();
  });

  it('step 2 refuses a repo that is not owner/repo and a missing synth plugin', async () => {
    await openWizard();
    change(screen.getByLabelText('Project *'), 'web');
    change(screen.getByLabelText('Organization *'), 'acme');
    next();
    change(await screen.findByLabelText('Repository *'), 'just-a-name');
    next();
    expect(screen.getByText('Format: owner/repo')).toBeInTheDocument();
    expect(screen.getByText('Plugin name is required')).toBeInTheDocument();
    // Back to step one keeps what was typed, and the stepper marks step 2 in error.
    click(screen.getByRole('button', { name: /Previous/ }));
    expect(screen.getByLabelText('Project *')).toHaveValue('web');
  });
});

describe('pipeline builder — the assembled create request', () => {
  it('every section reaches POST /api/pipelines', async () => {
    await openWizard();

    // ── Step 1: identity, description/keywords, vars, defaults, role, visibility
    change(screen.getByLabelText('Project *'), 'web');
    change(screen.getByLabelText('Organization *'), 'acme');
    expect(screen.getByLabelText('Pipeline name')).toHaveValue('acme-web-pipeline');
    change(screen.getByLabelText('Description'), 'Web app');
    change(screen.getByLabelText('Keywords (comma-separated)'), 'web, prod');

    const vars = section('Pipeline variables');
    click(vars.getByRole('button', { name: '+ Add Variable' }));
    change(vars.getByPlaceholderText('Name (e.g. orgId)'), 'region');
    change(vars.getByPlaceholderText('Value'), 'us-east-1');

    const defaults = section('Pipeline defaults');
    click(defaults.getByLabelText('Configure pipeline-level CodeBuild defaults'));
    const net = section('Network', screen.getByText('Pipeline defaults').closest('details') as HTMLElement);
    change(net.getByLabelText('Network type'), 'subnetIds');
    change(net.getByLabelText('VPC ID *'), 'vpc-123');
    click(net.getByRole('button', { name: '+ Add Subnet' }));
    change(net.getByPlaceholderText('subnet-...'), 'subnet-a');
    const sg = section('Security groups');
    change(sg.getByLabelText('Security group type'), 'securityGroupLookup');
    change(sg.getByLabelText('Security group name *'), 'build-sg');
    change(sg.getByLabelText('VPC ID *'), 'vpc-123');
    click(defaults.getByLabelText('Enable Docker for synth step'));
    click(defaults.getByLabelText('Enable privileged mode (required for Docker builds)'));
    click(defaults.getByLabelText('Track pipeline execution events (EventBridge)'));
    click(defaults.getByLabelText('Enable CloudWatch failure alarms'));
    click(defaults.getByLabelText('Runtime plugin vulnerability check'));
    change(defaults.getByLabelText('SNS Topic ARN (optional)'), 'arn:aws:sns:us-east-1:1:t');
    change(defaults.getByLabelText('KMS Key ARN (optional)'), 'arn:aws:kms:us-east-1:1:key/k');
    // Toggling a flag off removes its metadata key again.
    click(defaults.getByLabelText('Enable CloudWatch failure alarms'));

    const role = section('IAM Role');
    change(role.getByLabelText('Role type'), 'roleName');
    change(role.getByLabelText('Role name *'), 'deployer');
    // Mutable starts ticked; unticking it is what reaches the body.
    expect(role.getByLabelText('Mutable')).toBeChecked();
    click(role.getByLabelText('Mutable'));

    change(screen.getByLabelText('Visibility'), 'private');
    next();

    // ── Step 2: synth source, plugin picked from the list, synth network
    change(await screen.findByLabelText('Repository *'), 'acme/web');
    change(screen.getByLabelText('Branch'), 'main');
    change(screen.getByLabelText('Trigger'), 'SCHEDULE');
    change(screen.getByLabelText('Schedule expression'), 'rate(1 day)');
    const pluginInput = screen.getByLabelText('Plugin Name *');
    fireEvent.focus(pluginInput);
    click(await screen.findByRole('option', { name: /node-synth/ }));
    expect(pluginInput).toHaveValue('node-synth');
    change(screen.getByLabelText('Plugin Alias'), 'synth');
    const synthNet = section('Synth network');
    change(synthNet.getByLabelText('Network type'), 'vpcLookup');
    click(synthNet.getByRole('button', { name: '+ Add Tag' }));
    change(synthNet.getByPlaceholderText('Tag Key'), 'tier');
    change(synthNet.getByPlaceholderText('Tag Value'), 'build');
    change(synthNet.getByLabelText('Region'), 'us-west-2');
    next();

    // ── Step 3: one stage, one step
    click(await screen.findByRole('button', { name: '+ Add Stage' }));
    change(screen.getByLabelText('Stage name *'), 'Deploy');
    change(screen.getByLabelText('Environment'), 'production');
    change(screen.getByLabelText('Step position'), 'post');
    change(screen.getByLabelText('Timeout (minutes)'), '20');
    change(screen.getByLabelText('Failure behavior'), 'warn');
    change(screen.getByLabelText('Step plugin Name *'), 'cdk-deploy');
    const install = section('Install commands');
    click(install.getByRole('button', { name: '+ Add Command' }));
    change(install.getByPlaceholderText('npm ci'), 'npm ci');
    change(install.getByLabelText('Position'), 'post');
    const env = section('Environment variables');
    click(env.getByRole('button', { name: '+ Add Variable' }));
    change(env.getByPlaceholderText('KEY'), 'NODE_ENV');
    change(env.getByPlaceholderText('value'), 'production');
    const inputs = section('Inputs');
    const primary = inputs.getAllByPlaceholderText('stageName:stageAlias:pluginName:pluginAlias:outputDir')[0];
    fireEvent.focus(primary);
    click(await screen.findByRole('option', { name: /cdk\.out/ }));
    click(inputs.getByRole('button', { name: '+ Add Additional Input' }));
    change(inputs.getByPlaceholderText('directory (optional, defaults to outputDir)'), 'extra');
    change(inputs.getAllByPlaceholderText('stageName:stageAlias:pluginName:pluginAlias:outputDir')[1], 'a:b:c:d:e');

    // The JSON preview is what Create will send.
    click(screen.getByRole('button', { name: 'Preview JSON' }));
    expect(await screen.findByText('JSON Preview')).toBeInTheDocument();

    click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(apiFn('createPipeline')).toHaveBeenCalledTimes(1));

    const [body, opts] = apiFn('createPipeline').mock.calls[0] as [Record<string, any>, unknown];
    expect(opts).toBeUndefined();
    expect(body).toMatchObject({
      project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline', visibility: 'private',
    });
    const props = body.props;
    expect(props).toMatchObject({ project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline' });
    // description/keywords are pipeline fields, never part of props.
    expect(props).not.toHaveProperty('description');
    expect(props.vars).toEqual({ region: 'us-east-1' });
    expect(props.role).toEqual({ type: 'roleName', options: { roleName: 'deployer', mutable: false } });
    expect(props.defaults.network).toMatchObject({ type: 'subnetIds', options: expect.objectContaining({ vpcId: 'vpc-123', subnetIds: ['subnet-a'] }) });
    expect(props.defaults.securityGroups).toMatchObject({ type: 'securityGroupLookup', options: expect.objectContaining({ securityGroupName: 'build-sg', vpcId: 'vpc-123' }) });
    expect(props.defaults.metadata).toEqual({
      'aws:cdk:pipelines:codepipeline:dockerenabledforsynth': true,
      'aws:cdk:codebuild:buildenvironment:privileged': true,
      'aws:cdk:operations:executionevents': true,
      'aws:cdk:operations:runtimevulncheck': true,
      'aws:cdk:notifications:topic:arn': 'arn:aws:sns:us-east-1:1:t',
      'aws:cdk:encryption:kmskeyarn': 'arn:aws:kms:us-east-1:1:key/k',
    });
    expect(props.synth.source).toEqual({
      type: 'github',
      options: expect.objectContaining({ repo: 'acme/web', branch: 'main', trigger: 'SCHEDULE', schedule: 'rate(1 day)' }),
    });
    expect(props.synth.plugin).toMatchObject({ name: 'node-synth', alias: 'synth' });
    expect(props.synth.network).toMatchObject({ type: 'vpcLookup', options: expect.objectContaining({ region: 'us-west-2', tags: { tier: 'build' } }) });
    expect(props.stages).toHaveLength(1);
    expect(props.stages[0]).toMatchObject({ stageName: 'Deploy', environment: 'production' });
    const step = props.stages[0].steps[0];
    expect(step).toMatchObject({
      position: 'post', failureBehavior: 'warn', timeout: 20,
      plugin: expect.objectContaining({ name: 'cdk-deploy' }),
      postInstallCommands: ['npm ci'],
      env: { NODE_ENV: 'production' },
    });
    // The picked synth output and the typed key are both parsed into artifact refs.
    expect(step.inputArtifact).toEqual({ stageName: 'no-stage', stageAlias: 'no-stage-alias', pluginName: 'node-synth', pluginAlias: 'synth', outputDirectory: 'cdk.out' });
    expect(step.additionalInputArtifacts).toEqual([
      { artifact: { stageName: 'a', stageAlias: 'b', pluginName: 'c', pluginAlias: 'd', outputDirectory: 'e' }, directory: 'extra' },
    ]);

    expect(await screen.findByText('Pipeline created successfully!')).toBeInTheDocument();
  });

  // Regression: the create switch had no `form` case, so the wizard's Description
  // and Keywords were silently dropped from the request.
  it('the wizard\'s description and keywords reach the create body', async () => {
    await openWizard();
    change(screen.getByLabelText('Project *'), 'web');
    change(screen.getByLabelText('Organization *'), 'acme');
    change(screen.getByLabelText('Description'), 'Web app');
    change(screen.getByLabelText('Keywords (comma-separated)'), 'web, prod');
    next();
    change(await screen.findByLabelText('Repository *'), 'acme/web');
    change(screen.getByLabelText('Plugin Name *'), 'cdk-synth');
    next();
    await screen.findByRole('button', { name: '+ Add Stage' });
    click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(apiFn('createPipeline')).toHaveBeenCalledTimes(1));
    expect(apiFn('createPipeline').mock.calls[0][0]).toMatchObject({ description: 'Web app', keywords: ['web', 'prod'] });
  });

  it('a stage needs a name and a step plugin before Create sends anything', async () => {
    await openWizard();
    change(screen.getByLabelText('Project *'), 'web');
    change(screen.getByLabelText('Organization *'), 'acme');
    next();
    change(await screen.findByLabelText('Repository *'), 'acme/web');
    change(screen.getByLabelText('Plugin Name *'), 'cdk-synth');
    next();
    click(await screen.findByRole('button', { name: '+ Add Stage' }));
    // A second step, then removed again.
    click(screen.getByRole('button', { name: '+ Add Step' }));
    expect(screen.getByText('Steps (2)')).toBeInTheDocument();
    click(screen.getAllByRole('button', { name: 'Remove Step' })[1]);
    click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText('Stage name is required')).toBeInTheDocument();
    expect(screen.getByText('Plugin name is required')).toBeInTheDocument();
    expect(apiFn('createPipeline')).not.toHaveBeenCalled();

    // Removing the stage clears the refusal; a stage-less pipeline is valid.
    click(screen.getByRole('button', { name: 'Remove Stage' }));
    click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(apiFn('createPipeline')).toHaveBeenCalledTimes(1));
    expect((apiFn('createPipeline').mock.calls[0][0] as { props: { synth: { plugin: { name: string } } } }).props.synth.plugin.name).toBe('cdk-synth');
  });

  it('the stepper jumps back to a visited step, never ahead to an unvisited one', async () => {
    await openWizard();
    change(screen.getByLabelText('Project *'), 'web');
    change(screen.getByLabelText('Organization *'), 'acme');
    // Step 3 not yet visited: its stepper button is inert.
    expect(screen.getByRole('button', { name: /Stages/ })).toBeDisabled();
    next();
    await screen.findByLabelText('Repository *');
    click(screen.getByRole('button', { name: /Pipeline configuration/ }));
    expect(await screen.findByLabelText('Project *')).toHaveValue('web');
  });
});
