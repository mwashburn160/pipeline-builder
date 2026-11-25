// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline build flow, which no suite loaded before:
 *  - CreatePipelineModal: the Upload path end to end (pasted JSON → validated
 *    props → onSubmit with the chosen visibility, wrapper description/keywords
 *    lifted off), the compliance preview (pass, violations, and a refused
 *    dry-run shown as a failure — never as a pass), and the AI tabs locked
 *    without the entitlement;
 *  - useFormBuilderState: the wizard's state → BuilderProps serialization and
 *    its validation gate.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';

let aiEntitled = true;
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: aiEntitled, isLoaded: true, label: 'AI', description: '', unlocks: '', upsellHref: '/', reason: 'not on plan' }),
}));
// The AI tabs and the wizard have their own suites/reads; this pins the modal.
jest.mock('@/components/pipeline/GitUrlTab', () => {
  const { forwardRef } = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: forwardRef(() => <div>git-url-tab</div>) };
});
jest.mock('@/components/pipeline/PromptGenerateTab', () => {
  const { forwardRef } = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: forwardRef(() => <div>prompt-tab</div>) };
});
jest.mock('@/components/pipeline/FormBuilderTab', () => {
  const { forwardRef } = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: forwardRef(() => <div>wizard-tab</div>) };
});
jest.mock('@/components/ui/FeatureLock', () => ({ __esModule: true, FeatureLock: () => <div>ai-locked</div> }));
// The deploy panel has its own suite (deploy-pipeline-panel): here it only has to be mounted for the new pipeline.
jest.mock('@/components/pipeline/DeployPipelinePanel', () => ({
  __esModule: true,
  DeployPipelinePanel: ({ pipelineId }: { pipelineId: string }) => <div data-testid="deploy-panel">deploy-panel:{pipelineId}</div>,
}));

const dryRunPipelineCompliance = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { dryRunPipelineCompliance: (...a: unknown[]) => dryRunPipelineCompliance(...a) },
}));

import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import { useFormBuilderState } from '@/hooks/useFormBuilderState';

const PROPS = {
  project: 'web', organization: 'acme',
  synth: { source: { type: 'github', options: { repo: 'acme/web' } }, plugin: { name: 'cdk-synth' } },
};

function renderModal(over: Record<string, unknown> = {}) {
  const onSubmit = jest.fn<AnyFn>().mockResolvedValue(undefined);
  render(
    <CreatePipelineModal
      isOpen onClose={jest.fn<AnyFn>()} onSubmit={onSubmit}
      createLoading={false} createError={null} createSuccess={null} canPublish={false}
      {...over}
    />,
  );
  return { onSubmit };
}
const openUpload = () => fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
const paste = (json: unknown) => fireEvent.change(screen.getByLabelText('Pipeline Props (JSON)'), { target: { value: JSON.stringify(json) } });

beforeEach(() => {
  jest.clearAllMocks();
  aiEntitled = true;
});

describe('CreatePipelineModal — Upload path', () => {
  it('submits pasted props with the default org visibility', async () => {
    const { onSubmit } = renderModal();
    openUpload();
    paste(PROPS);
    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(PROPS, 'org', undefined, undefined));
  });

  it('unwraps a full pipeline export and lifts its description and keywords', async () => {
    const { onSubmit } = renderModal();
    openUpload();
    paste({ project: 'ignored', props: PROPS, description: 'Web app', keywords: ['web', 'prod'], pipelineName: 'x' });
    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(PROPS, 'org', 'Web app', ['web', 'prod']));
  });

  it('refuses invalid JSON and props missing required fields, without submitting', async () => {
    const { onSubmit } = renderModal();
    openUpload();
    fireEvent.change(screen.getByLabelText('Pipeline Props (JSON)'), { target: { value: '{nope' } });
    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    expect(await screen.findByText(/Invalid JSON format/)).toBeInTheDocument();
    paste({ project: 'web', synth: {} });
    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    expect(await screen.findByText(/must include "organization"/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('CreatePipelineModal — compliance preview', () => {
  it('shows a pass', async () => {
    dryRunPipelineCompliance.mockResolvedValue({ success: true, data: { passed: true, blocked: false, rulesEvaluated: 4, rulesSkipped: 0, violations: [], warnings: [], exemptionsApplied: [] } });
    renderModal();
    openUpload();
    paste(PROPS);
    fireEvent.click(screen.getByRole('button', { name: /Preview Compliance/ }));
    expect(await screen.findByText('All compliance checks passed.')).toBeInTheDocument();
    expect(dryRunPipelineCompliance).toHaveBeenCalledWith(PROPS);
  });

  it('shows violations', async () => {
    dryRunPipelineCompliance.mockResolvedValue({ success: true, data: { passed: false, blocked: true, rulesEvaluated: 4, rulesSkipped: 0, violations: [{ ruleId: 'r', ruleName: 'n', field: 'f', operator: 'eq', expectedValue: '', actualValue: '', severity: 'critical', message: 'Public repos are blocked' }], warnings: [], exemptionsApplied: [] } });
    renderModal();
    openUpload();
    paste(PROPS);
    fireEvent.click(screen.getByRole('button', { name: /Preview Compliance/ }));
    expect(await screen.findByText('Public repos are blocked')).toBeInTheDocument();
  });

  it('a refused or failed dry-run reads as a failure, never a pass', async () => {
    dryRunPipelineCompliance.mockResolvedValueOnce({ success: false, message: 'compliance unavailable' }).mockRejectedValueOnce(new Error('x'));
    renderModal();
    openUpload();
    paste(PROPS);
    fireEvent.click(screen.getByRole('button', { name: /Preview Compliance/ }));
    expect(await screen.findByText('compliance unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Preview Compliance/ }));
    expect(await screen.findByText('Failed to run compliance check')).toBeInTheDocument();
    expect(screen.queryByText('All compliance checks passed.')).not.toBeInTheDocument();
  });
});

describe('CreatePipelineModal — next step: deploy it', () => {
  it('a created pipeline offers the deploy through a runner, with the CLI command as the alternative', () => {
    renderModal({ createdPipelineId: 'p-new', createSuccess: 'Pipeline created' });
    const next = screen.getByRole('region', { name: 'Next step: deploy' });
    expect(next).toContainElement(screen.getByTestId('deploy-panel'));
    expect(screen.getByTestId('deploy-panel')).toHaveTextContent('deploy-panel:p-new');
    expect(next).toHaveTextContent('pipeline-manager pipeline deploy --id p-new');
    expect(next).toHaveTextContent(/Or deploy it from a machine with AWS credentials/);
  });
});

describe('CreatePipelineModal — AI entitlement', () => {
  it('locks the AI tabs (and Create) without ai_generation, but leaves Upload usable', () => {
    aiEntitled = false;
    renderModal();
    expect(screen.getByText('ai-locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
    openUpload();
    expect(screen.getByRole('button', { name: /Create/ })).not.toBeDisabled();
  });

  it('opens on the wizard with Next instead of Create', () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: 'Wizard' }));
    expect(screen.getByText('wizard-tab')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <CreatePipelineModal isOpen={false} onClose={jest.fn<AnyFn>()} onSubmit={jest.fn<AnyFn>()} createLoading={false} createError={null} createSuccess={null} canPublish={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useFormBuilderState', () => {
  it('derives the pipeline name from org + project until it is edited directly', () => {
    const { result } = renderHook(() => useFormBuilderState());
    act(() => {
      result.current.dispatch({ type: 'SET_CORE', field: 'organization', value: 'acme' });
      result.current.dispatch({ type: 'SET_CORE', field: 'project', value: 'web' });
    });
    expect(result.current.state.pipelineName).toBe('acme-web-pipeline');
    act(() => { result.current.dispatch({ type: 'SET_CORE', field: 'pipelineName', value: 'custom' }); });
    expect(result.current.state.pipelineName).toBe('custom');
  });

  it('refuses to assemble an incomplete form and names the fields', () => {
    const { result } = renderHook(() => useFormBuilderState());
    let props: unknown;
    act(() => { props = result.current.assembleBuilderProps(); });
    expect(props).toBeNull();
    expect(result.current.validationErrors).toMatchObject({
      project: expect.any(String), organization: expect.any(String),
      'synth.github.repo': expect.any(String), 'synth.plugin.name': expect.any(String),
    });
    // The preview path skips validation, so a half-built form can still be shown.
    expect(result.current.assembleBuilderPropsForPreview()).not.toBeNull();
  });

  it('serializes a complete form into BuilderProps, stages included', () => {
    const { result } = renderHook(() => useFormBuilderState());
    act(() => {
      result.current.dispatch({ type: 'SET_CORE', field: 'organization', value: 'acme' });
      result.current.dispatch({ type: 'SET_CORE', field: 'project', value: 'web' });
      result.current.dispatch({ type: 'SET_SYNTH_GITHUB', field: 'repo', value: 'acme/web' });
      result.current.dispatch({ type: 'SET_SYNTH_PLUGIN', value: { ...result.current.state.synth.plugin, name: 'cdk-synth' } });
    });
    let props: Record<string, unknown> | null = null;
    act(() => { props = result.current.assembleBuilderProps() as Record<string, unknown> | null; });
    expect(result.current.validationErrors).toEqual({});
    expect(props).toMatchObject({
      project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline',
      synth: { source: { type: 'github', options: expect.objectContaining({ repo: 'acme/web' }) }, plugin: expect.objectContaining({ name: 'cdk-synth' }) },
    });

    // A new stage starts with one empty step, whose plugin is required.
    act(() => {
      result.current.dispatch({ type: 'ADD_STAGE' });
      result.current.dispatch({ type: 'SET_STAGE_FIELD', index: 0, field: 'stageName', value: 'Deploy' });
    });
    act(() => { result.current.assembleBuilderProps(); });
    expect(Object.keys(result.current.validationErrors)).toEqual(['stages.0.steps.0.plugin.name']);

    const step = result.current.state.stages[0].steps[0];
    act(() => {
      result.current.dispatch({ type: 'SET_STEP', stageIndex: 0, stepIndex: 0, step: { ...step, plugin: { ...step.plugin, name: 'deploy' } } });
    });
    act(() => { props = result.current.assembleBuilderProps() as Record<string, unknown> | null; });
    expect(result.current.validationErrors).toEqual({});
    expect((props as unknown as { stages: Array<{ stageName: string }> }).stages[0].stageName).toBe('Deploy');

    act(() => { result.current.dispatch({ type: 'REMOVE_STAGE', index: 0 }); result.current.reset(); });
    expect(result.current.state.project).toBe('');
  });
});

describe('useFormBuilderState reducer → assembly, section by section', () => {
  const ready = () => {
    const h = renderHook(() => useFormBuilderState());
    act(() => {
      h.result.current.dispatch({ type: 'SET_CORE', field: 'organization', value: 'acme' });
      h.result.current.dispatch({ type: 'SET_CORE', field: 'project', value: 'web' });
      h.result.current.dispatch({ type: 'SET_SYNTH_GITHUB', field: 'repo', value: 'acme/web' });
      h.result.current.dispatch({ type: 'SET_SYNTH_PLUGIN', value: { ...h.result.current.state.synth.plugin, name: 'cdk-synth' } });
    });
    return h;
  };
  const assemble = (h: ReturnType<typeof ready>) => {
    let out: Record<string, any> | null = null;
    act(() => { out = h.result.current.assembleBuilderProps() as Record<string, any> | null; });
    return out as unknown as Record<string, any>;
  };

  it('description, keywords, global metadata, vars and the toolchain pin', () => {
    const h = ready();
    act(() => {
      h.result.current.dispatch({ type: 'SET_DESCRIPTION', value: 'Web' });
      h.result.current.dispatch({ type: 'SET_KEYWORDS', value: 'a, b' });
      h.result.current.dispatch({ type: 'SET_GLOBAL_METADATA', value: [{ key: 'team', value: 'core', type: 'string' }] });
      h.result.current.dispatch({ type: 'SET_VARS', value: [{ key: 'n', value: '3', type: 'number' }, { key: 'on', value: 'true', type: 'boolean' }] });
      h.result.current.dispatch({ type: 'SET_TOOLCHAIN_RELEASE', value: '1.4.2' });
    });
    expect(h.result.current.state).toMatchObject({ description: 'Web', keywords: 'a, b', toolchainRelease: '1.4.2' });
    const out = assemble(h);
    expect(out.global).toEqual({ team: 'core' });
    expect(out.vars).toEqual({ n: 3, on: true });
  });

  it('defaults: network, security group and metadata', () => {
    const h = ready();
    const net = { ...h.result.current.state.defaults.network, vpcId: 'vpc-1', subnetIds: ['s1'] };
    act(() => {
      h.result.current.dispatch({ type: 'SET_DEFAULTS_ENABLED', value: true });
      h.result.current.dispatch({ type: 'SET_DEFAULTS_NETWORK_TYPE', value: 'subnetIds' });
      h.result.current.dispatch({ type: 'SET_DEFAULTS_NETWORK', value: net });
      h.result.current.dispatch({ type: 'SET_DEFAULTS_SG_TYPE', value: 'securityGroupIds' });
      h.result.current.dispatch({ type: 'SET_DEFAULTS_SG', value: { securityGroupIds: ['sg-1'], mutable: false, securityGroupName: '', vpcId: '' } });
      h.result.current.dispatch({ type: 'SET_DEFAULTS_METADATA', value: [{ key: 'k', value: 'v', type: 'string' }] });
    });
    const out = assemble(h);
    expect(out.defaults.network).toMatchObject({ type: 'subnetIds' });
    expect(out.defaults.securityGroups).toMatchObject({ type: 'securityGroupIds' });
    expect(out.defaults.metadata).toEqual({ k: 'v' });
  });

  it.each([
    ['roleArn', { roleArn: 'arn:aws:iam::1:role/x' }, { type: 'roleArn', options: { roleArn: 'arn:aws:iam::1:role/x', mutable: false } }],
    ['roleName', { roleName: 'deployer' }, { type: 'roleName', options: { roleName: 'deployer', mutable: false } }],
    ['codeBuildDefault', { roleName: 'cb' }, { type: 'codeBuildDefault', options: { roleName: 'cb' } }],
    // Every OIDC role needs a `<host>:sub` condition (an unscoped role trusts every repository).
    ['oidc', { oidcIssuer: 'https://issuer', oidcClientIds: 'a, b', oidcConditions: 'issuer:sub=repo:x\nbad\nissuer:aud=sts', oidcDescription: 'GH', roleName: 'r' },
      { type: 'oidc', options: { issuer: 'https://issuer', clientIds: ['a', 'b'], conditions: { 'issuer:sub': 'repo:x', 'issuer:aud': 'sts' }, description: 'GH', roleName: 'r' } }],
    ['oidc', { oidcProviderArn: 'arn:oidc', oidcConditions: 'issuer:sub=repo:x' }, { type: 'oidc', options: { providerArn: 'arn:oidc', conditions: { 'issuer:sub': 'repo:x' } } }],
  ] as const)('role %s', (type, fields, expected) => {
    const h = ready();
    act(() => {
      h.result.current.dispatch({ type: 'SET_ROLE_TYPE', value: type });
      h.result.current.dispatch({ type: 'SET_ROLE_MUTABLE', value: false });
      for (const [field, value] of Object.entries(fields)) {
        h.result.current.dispatch({ type: 'SET_ROLE_FIELD', field: field as 'roleArn', value });
      }
    });
    expect(assemble(h).role).toEqual(expected);
  });

  it.each([
    ['s3', 'SET_SYNTH_S3', { bucketName: 'b', objectKey: 'k.zip', trigger: 'SCHEDULE', schedule: 'rate(1 day)' }],
    ['codestar', 'SET_SYNTH_CODESTAR', { repo: 'acme/web', connectionArn: 'arn:c', branch: 'main', codeBuildCloneOutput: true }],
    ['codecommit', 'SET_SYNTH_CODECOMMIT', { repositoryName: 'web', branch: 'dev' }],
  ] as const)('source %s', (sourceType, action, fields) => {
    const h = ready();
    act(() => {
      h.result.current.dispatch({ type: 'SET_SYNTH_SOURCE_TYPE', value: sourceType });
      for (const [field, value] of Object.entries(fields)) {
        h.result.current.dispatch({ type: action, field, value } as never);
      }
    });
    expect(assemble(h).synth.source).toEqual({ type: sourceType, options: fields });
  });

  it('synth metadata + network, and stage/step edits', () => {
    const h = ready();
    act(() => {
      h.result.current.dispatch({ type: 'SET_SYNTH_METADATA', value: [{ key: 'm', value: '1', type: 'number' }] });
      h.result.current.dispatch({ type: 'SET_SYNTH_NETWORK_TYPE', value: 'vpcLookup' });
      h.result.current.dispatch({ type: 'SET_SYNTH_NETWORK', value: { ...h.result.current.state.synth.network, vpcName: 'main', region: 'us-west-2' } });
      h.result.current.dispatch({ type: 'ADD_STAGE' });
      h.result.current.dispatch({ type: 'SET_STAGE_FIELD', index: 0, field: 'stageName', value: 'Prod' });
      h.result.current.dispatch({ type: 'ADD_STEP', stageIndex: 0 });
      h.result.current.dispatch({ type: 'REMOVE_STEP', stageIndex: 0, stepIndex: 1 });
    });
    const step = h.result.current.state.stages[0].steps[0];
    act(() => {
      h.result.current.dispatch({ type: 'SET_STEP', stageIndex: 0, stepIndex: 0, step: {
        ...step, plugin: { ...step.plugin, name: 'deploy' },
        installCommands: { position: 'post', commands: ['npm ci'] }, buildCommands: { position: 'pre', commands: ['make'] },
        env: [{ key: 'A', value: '1' }], timeout: '15', failureBehavior: 'ignore',
      } });
    });
    const out = assemble(h);
    expect(out.synth.metadata).toEqual({ m: 1 });
    expect(out.synth.network).toMatchObject({ type: 'vpcLookup' });
    expect(out.stages[0].steps).toHaveLength(1);
    expect(out.stages[0].steps[0]).toMatchObject({ postInstallCommands: ['npm ci'], preCommands: ['make'], env: { A: '1' }, failureBehavior: 'ignore' });

    // REPLACE swaps the whole state (hand-edited raw JSON applied back).
    const snapshot = h.result.current.state;
    act(() => { h.result.current.dispatch({ type: 'RESET' }); });
    act(() => { h.result.current.dispatch({ type: 'REPLACE', value: snapshot }); });
    expect(h.result.current.state.project).toBe('web');
  });
});
