// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline builder's editors and sections, each mounted on its own against
 * a small stateful harness (so a change re-renders the way FormBuilderTab
 * would) — the branches the end-to-end create flow does not walk:
 *  - SourceTypeEditor: the S3 / CodeStar / CodeCommit forms, each schedule
 *    field shown only on the SCHEDULE trigger, the CodeStar clone-output flag;
 *  - NetworkConfigEditor: VPC-by-id (subnet type, AZs, subnet group, SGs) and
 *    tag lookup with tag rows added / edited / removed;
 *  - SecurityGroupEditor: explicit ids with the mutable toggle;
 *  - EnvEditor: add / edit / remove rows;
 *  - ArtifactKeyCombobox: keyboard selection, free text, and no list when
 *    there is nothing to offer or it is disabled;
 *  - WizardStepper: per-step status (valid tick, error, untouched) and which
 *    steps are clickable;
 *  - RoleSection: ARN / CodeBuild-default / OIDC-provider-ARN fields;
 *  - SynthSection / StagesSection / StepEditor: build commands, metadata,
 *    network, alias, and the disabled form.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { useState, type ReactElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());

import SourceTypeEditor from '@/components/pipeline/editors/SourceTypeEditor';
import NetworkConfigEditor from '@/components/pipeline/editors/NetworkConfigEditor';
import SecurityGroupEditor from '@/components/pipeline/editors/SecurityGroupEditor';
import EnvEditor from '@/components/pipeline/editors/EnvEditor';
import ArtifactKeyCombobox from '@/components/pipeline/editors/ArtifactKeyCombobox';
import WizardStepper from '@/components/pipeline/WizardStepper';
import RoleSection from '@/components/pipeline/sections/RoleSection';
import SynthSection from '@/components/pipeline/sections/SynthSection';
import StagesSection from '@/components/pipeline/sections/StagesSection';
import StepEditor from '@/components/pipeline/sections/StepEditor';
import DefaultsSection from '@/components/pipeline/sections/DefaultsSection';
import PipelineConfigSection from '@/components/pipeline/sections/PipelineConfigSection';
import { createEmptyStage, createEmptyStep, createInitialFormState, type FormBuilderState, type FormStep } from '@/types/form-types';
import { WIZARD_STEPS } from '@/lib/wizard-validation';

const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

/** Render `make(value, set)` with `value` held in React state. */
function Harness<T>({ initial, make, onValue }: { initial: T; make: (v: T, set: (n: T) => void) => ReactElement; onValue?: (v: T) => void }) {
  const [v, setV] = useState(initial);
  return make(v, (n) => { setV(n); onValue?.(n); });
}

describe('SourceTypeEditor', () => {
  type Synth = FormBuilderState['synth'];
  function renderSource(sourceType: Synth['sourceType']) {
    const seen: Array<[string, string, unknown]> = [];
    const initial = { ...createInitialFormState().synth, sourceType };
    render(
      <Harness
        initial={initial}
        make={(s, set) => (
          <SourceTypeEditor
            sourceType={s.sourceType} s3={s.s3} github={s.github} codestar={s.codestar} codecommit={s.codecommit}
            onSourceTypeChange={(t) => set({ ...s, sourceType: t })}
            onS3Change={(f, v) => { seen.push(['s3', f, v]); set({ ...s, s3: { ...s.s3, [f]: v } }); }}
            onGithubChange={(f, v) => { seen.push(['github', f, v]); set({ ...s, github: { ...s.github, [f]: v } }); }}
            onCodestarChange={(f, v) => { seen.push(['codestar', f, v]); set({ ...s, codestar: { ...s.codestar, [f]: v } }); }}
            onCodecommitChange={(f, v) => { seen.push(['codecommit', f, v]); set({ ...s, codecommit: { ...s.codecommit, [f]: v } }); }}
            errors={{ 'synth.s3.bucketName': 'Bucket name is required' }}
          />
        )}
      />,
    );
    return seen;
  }

  it('S3: bucket (with its inline error), key, and a schedule only on SCHEDULE', () => {
    const seen = renderSource('s3');
    expect(screen.getByText('Bucket name is required')).toBeInTheDocument();
    change(screen.getByLabelText('Bucket name *'), 'src-bucket');
    change(screen.getByLabelText('Object key'), 'src.zip');
    expect(screen.queryByLabelText('Schedule expression')).not.toBeInTheDocument();
    change(screen.getByLabelText('Trigger'), 'SCHEDULE');
    change(screen.getByLabelText('Schedule expression'), 'cron(0 8 * * ? *)');
    expect(seen).toEqual([
      ['s3', 'bucketName', 'src-bucket'], ['s3', 'objectKey', 'src.zip'],
      ['s3', 'trigger', 'SCHEDULE'], ['s3', 'schedule', 'cron(0 8 * * ? *)'],
    ]);
  });

  it('GitHub: the token field is a masked text input and never autocompletes', () => {
    renderSource('github');
    const token = screen.getByLabelText('Token (PAT)');
    expect(token).toHaveAttribute('autocomplete', 'off');
    change(token, 'ghp_x');
    expect(token).toHaveValue('ghp_x');
  });

  it('CodeStar: repo, branch, connection ARN, schedule and the clone-output flag', () => {
    const seen = renderSource('codestar');
    change(screen.getByLabelText('Repository *'), 'acme/web');
    change(screen.getByLabelText('Branch'), 'dev');
    change(screen.getByLabelText('Connection ARN *'), 'arn:aws:codestar-connections:x');
    change(screen.getByLabelText('Trigger'), 'SCHEDULE');
    change(screen.getByLabelText('Schedule expression'), 'rate(1 hour)');
    fireEvent.click(screen.getByLabelText('CodeBuild Clone Output'));
    expect(seen).toContainEqual(['codestar', 'codeBuildCloneOutput', true]);
    expect(seen).toContainEqual(['codestar', 'connectionArn', 'arn:aws:codestar-connections:x']);
    expect(seen).toContainEqual(['codestar', 'schedule', 'rate(1 hour)']);
  });

  it('CodeCommit: repository name, branch and schedule; switching type swaps the form', () => {
    const seen = renderSource('codecommit');
    change(screen.getByLabelText('Repository name *'), 'web');
    change(screen.getByLabelText('Branch'), 'main');
    change(screen.getByLabelText('Trigger'), 'SCHEDULE');
    change(screen.getByLabelText('Schedule expression'), 'rate(2 days)');
    expect(seen).toContainEqual(['codecommit', 'schedule', 'rate(2 days)']);
    change(screen.getByLabelText('Source type'), 'github');
    expect(screen.queryByLabelText('Repository name *')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Repository *')).toBeInTheDocument();
    // GitHub's own schedule field.
    change(screen.getByLabelText('Trigger'), 'SCHEDULE');
    change(screen.getByLabelText('Schedule expression'), 'rate(3 days)');
    expect(seen).toContainEqual(['github', 'schedule', 'rate(3 days)']);
  });
});

describe('NetworkConfigEditor', () => {
  const initialNet = () => createInitialFormState().synth.network;
  function renderNet(networkType: 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup', onValue = jest.fn<AnyFn>()) {
    render(
      <Harness
        initial={{ networkType, network: initialNet() }}
        onValue={onValue}
        make={(v, set) => (
          <NetworkConfigEditor
            networkType={v.networkType} network={v.network}
            onTypeChange={(t) => set({ ...v, networkType: t })}
            onNetworkChange={(n) => set({ ...v, network: n })}
          />
        )}
      />,
    );
    return onValue;
  }
  const last = (fn: jest.Mock<AnyFn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as { networkType: string; network: Record<string, unknown> };

  it('VPC by id: subnet type, availability zones, subnet group and security groups', () => {
    const onValue = renderNet('vpcId');
    change(screen.getByLabelText('VPC ID *'), 'vpc-9');
    change(screen.getByLabelText('Subnet type'), 'PUBLIC');
    fireEvent.click(screen.getByRole('button', { name: '+ Add AZ' }));
    change(screen.getByPlaceholderText('us-east-1a'), 'us-east-1b');
    change(screen.getByLabelText('Subnet group name'), 'private');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Security Group' }));
    change(screen.getByPlaceholderText('sg-...'), 'sg-1');
    expect(last(onValue).network).toMatchObject({
      vpcId: 'vpc-9', subnetType: 'PUBLIC', availabilityZones: ['us-east-1b'], subnetGroupName: 'private', securityGroupIds: ['sg-1'],
    });
    // A row can be removed again.
    fireEvent.click(within(screen.getByPlaceholderText('sg-...').parentElement as HTMLElement).getByRole('button', { name: 'Remove' }));
    expect(last(onValue).network.securityGroupIds).toEqual([]);
  });

  it('tag lookup: tags are added, edited and removed; name, subnet type, AZs and SGs too', () => {
    const onValue = renderNet('vpcLookup');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Tag' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add Tag' }));
    const keys = screen.getAllByPlaceholderText('Tag Key');
    change(keys[0], 'env');
    change(screen.getAllByPlaceholderText('Tag Value')[0], 'prod');
    change(keys[1], 'gone');
    fireEvent.click(within(keys[1].parentElement as HTMLElement).getByRole('button', { name: 'Remove' }));
    change(screen.getByLabelText('VPC Name'), 'main');
    change(screen.getByLabelText('Subnet type'), 'PRIVATE_ISOLATED');
    change(screen.getByLabelText('Subnet group name'), 'grp');
    fireEvent.click(screen.getByRole('button', { name: '+ Add AZ' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add Security Group' }));
    expect(last(onValue).network).toMatchObject({
      tags: [{ key: 'env', value: 'prod' }], vpcName: 'main', subnetType: 'PRIVATE_ISOLATED', subnetGroupName: 'grp',
      availabilityZones: [''], securityGroupIds: [''],
    });
  });

  it('subnet ids: security groups alongside subnets; "None" hides every field', () => {
    const onValue = renderNet('subnetIds');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Security Group' }));
    change(screen.getByPlaceholderText('sg-...'), 'sg-2');
    expect(last(onValue).network.securityGroupIds).toEqual(['sg-2']);
    change(screen.getByLabelText('Network type'), 'none');
    expect(screen.queryByLabelText('VPC ID *')).not.toBeInTheDocument();
  });
});

describe('SecurityGroupEditor', () => {
  it('explicit ids with the mutable toggle; lookup shows name + VPC', () => {
    const onValue = jest.fn<AnyFn>();
    render(
      <Harness
        initial={{ t: 'securityGroupIds' as 'none' | 'securityGroupIds' | 'securityGroupLookup', sg: createInitialFormState().defaults.securityGroup }}
        onValue={onValue}
        make={(v, set) => (
          <SecurityGroupEditor
            securityGroupType={v.t} securityGroup={v.sg}
            onTypeChange={(t) => set({ ...v, t })}
            onSecurityGroupChange={(sg) => set({ ...v, sg })}
          />
        )}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Add Security Group' }));
    change(screen.getByPlaceholderText('sg-...'), 'sg-7');
    expect(screen.getByLabelText('Mutable')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Mutable'));
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ sg: expect.objectContaining({ securityGroupIds: ['sg-7'], mutable: false }) }));
    change(screen.getByLabelText('Security group type'), 'securityGroupLookup');
    expect(screen.getByLabelText('Security group name *')).toBeInTheDocument();
    change(screen.getByLabelText('Security group type'), 'none');
    expect(screen.queryByLabelText('Security group name *')).not.toBeInTheDocument();
  });
});

describe('EnvEditor', () => {
  it('adds, edits and removes KEY=value rows; disabled locks every control', () => {
    const onValue = jest.fn<AnyFn>();
    const { unmount } = render(
      <Harness initial={[] as Array<{ key: string; value: string }>} onValue={onValue} make={(v, set) => <EnvEditor value={v} onChange={set} />} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Add Variable' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add Variable' }));
    change(screen.getAllByPlaceholderText('KEY')[0], 'A');
    change(screen.getAllByPlaceholderText('value')[0], '1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(onValue).toHaveBeenLastCalledWith([{ key: 'A', value: '1' }]);
    expect(screen.getByRole('group', { name: 'Environment variables' })).toBeInTheDocument();
    unmount();

    render(<EnvEditor value={[{ key: 'B', value: '2' }]} onChange={jest.fn<AnyFn>()} disabled />);
    expect(screen.getByDisplayValue('B')).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Add Variable' })).toBeDisabled();
  });
});

describe('ArtifactKeyCombobox', () => {
  const OPTIONS = [
    { key: 'no-stage:no-stage-alias:synth:synth-alias:cdk.out', label: 'synth → cdk.out', category: 'Synth' },
    { key: 'Build:Build-alias:test:test-alias:reports', label: 'test → reports', category: 'Build' },
  ];

  it('opens on focus, walks the options with the arrow keys and picks with Enter', () => {
    const onChange = jest.fn<AnyFn>();
    render(<Harness initial="" onValue={onChange} make={(v, set) => <ArtifactKeyCombobox value={v} onChange={set} options={OPTIONS} />} />);
    const input = screen.getByPlaceholderText('Type or select artifact key');
    fireEvent.focus(input);
    const list = screen.getByRole('listbox', { name: 'Artifact keys' });
    expect(within(list).getByText('Synth')).toBeInTheDocument();
    expect(within(list).getByText('Build')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /test → reports/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('Build:Build-alias:test:test-alias:reports');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('free text filters the list; hover then click picks; Escape closes', () => {
    const onChange = jest.fn<AnyFn>();
    render(<Harness initial="" onValue={onChange} make={(v, set) => <ArtifactKeyCombobox value={v} onChange={set} options={OPTIONS} />} />);
    const input = screen.getByPlaceholderText('Type or select artifact key');
    fireEvent.focus(input);
    change(input, 'cdk');
    expect(onChange).toHaveBeenLastCalledWith('cdk');
    expect(screen.queryByText('test → reports')).not.toBeInTheDocument();
    const opt = screen.getByRole('option', { name: /synth → cdk\.out/ });
    fireEvent.mouseEnter(opt);
    fireEvent.mouseDown(opt);
    fireEvent.click(opt);
    expect(onChange).toHaveBeenLastCalledWith('no-stage:no-stage-alias:synth:synth-alias:cdk.out');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('no list with no options, or while disabled', () => {
    const { unmount } = render(<ArtifactKeyCombobox value="" onChange={jest.fn<AnyFn>()} options={[]} />);
    fireEvent.focus(screen.getByPlaceholderText('Type or select artifact key'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    unmount();
    render(<ArtifactKeyCombobox value="" onChange={jest.fn<AnyFn>()} options={OPTIONS} disabled placeholder="pick" />);
    fireEvent.focus(screen.getByPlaceholderText('pick'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('WizardStepper', () => {
  it('ticks a completed valid step, flags an error step, and gates clicks to visited steps', () => {
    const onStepClick = jest.fn<AnyFn>();
    render(<WizardStepper steps={WIZARD_STEPS} currentStep={1} onStepClick={onStepClick} stepStatus={{ 0: 'valid', 1: 'error', 2: 'untouched' }} />);
    const [first, second, third] = screen.getAllByRole('button');
    expect(first.querySelector('svg')).not.toBeNull(); // the check mark replaces the number
    expect(second).toHaveAttribute('aria-current', 'step');
    expect(second.firstElementChild?.className).toMatch(/bg-brand/);
    expect(third).toBeDisabled();
    fireEvent.click(first);
    fireEvent.click(third);
    expect(onStepClick).toHaveBeenCalledTimes(1);
    expect(onStepClick).toHaveBeenCalledWith(0);
  });

  it('without a click handler nothing is clickable; an errored future step shows red', () => {
    render(<WizardStepper steps={WIZARD_STEPS} currentStep={0} stepStatus={{ 2: 'error' }} />);
    const buttons = screen.getAllByRole('button');
    buttons.forEach((b) => expect(b).toBeDisabled());
    expect(buttons[2].firstElementChild?.className).toMatch(/bg-red-500/);
    expect(buttons[2]).toHaveTextContent('3');
  });
});

describe('RoleSection', () => {
  type Role = FormBuilderState['role'];
  function renderRole(type: Role['type'], errors: Record<string, string> = {}) {
    const fields: Array<[string, string]> = [];
    const onMutable = jest.fn<AnyFn>();
    render(
      <Harness
        initial={{ ...createInitialFormState().role, type }}
        make={(r, set) => (
          <RoleSection
            role={r}
            onTypeChange={(t) => set({ ...r, type: t })}
            onFieldChange={(f, v) => { fields.push([f, v]); set({ ...r, [f]: v }); }}
            onMutableChange={(m) => { onMutable(m); set({ ...r, mutable: m }); }}
            errors={errors}
          />
        )}
      />,
    );
    return { fields, onMutable };
  }

  it('role ARN with its inline error and mutable toggle', () => {
    const { fields, onMutable } = renderRole('roleArn', { 'role.roleArn': 'Role ARN is required' });
    expect(screen.getByText('Role ARN is required')).toBeInTheDocument();
    change(screen.getByLabelText('Role ARN *'), 'arn:aws:iam::1:role/r');
    fireEvent.click(screen.getByLabelText('Mutable'));
    expect(fields).toEqual([['roleArn', 'arn:aws:iam::1:role/r']]);
    expect(onMutable).toHaveBeenCalledWith(false);
  });

  it('CodeBuild default takes an optional name; OIDC by provider ARN locks the issuer', () => {
    const { fields } = renderRole('codeBuildDefault');
    change(screen.getByLabelText('Role name (optional)'), 'cb-role');
    change(screen.getByLabelText('Role type'), 'oidc');
    change(screen.getByLabelText('Provider ARN'), 'arn:aws:iam::1:oidc-provider/x');
    expect(screen.getByLabelText('Issuer URL')).toBeDisabled();
    change(screen.getByLabelText('Client IDs (comma-separated)'), 'sts.amazonaws.com');
    change(screen.getByLabelText('Description (optional)'), 'CI');
    change(screen.getByLabelText('Role name (optional)'), 'gh');
    expect(fields.map(([f]) => f)).toEqual(['roleName', 'oidcProviderArn', 'oidcClientIds', 'oidcDescription', 'roleName']);
    change(screen.getByLabelText('Role type'), 'none');
    expect(screen.queryByLabelText('Provider ARN')).not.toBeInTheDocument();
  });
});

describe('SynthSection / StagesSection / StepEditor', () => {
  it('SynthSection marks itself configured and passes metadata + plugin edits through', () => {
    const onPlugin = jest.fn<AnyFn>();
    const onMeta = jest.fn<AnyFn>();
    const synth = { ...createInitialFormState().synth, sourceType: 's3' as const };
    const noop = jest.fn<AnyFn>();
    const { rerender } = render(
      <SynthSection
        synth={synth} onSourceTypeChange={noop} onS3Change={noop} onGithubChange={noop} onCodestarChange={noop} onCodecommitChange={noop}
        onPluginChange={onPlugin} onMetadataChange={onMeta} onNetworkTypeChange={noop} onNetworkChange={noop}
      />,
    );
    // S3, no plugin, no metadata, no network: nothing configured yet.
    expect(screen.queryByText('configured')).not.toBeInTheDocument();
    change(screen.getByLabelText('Plugin Name *'), 'synth');
    expect(onPlugin).toHaveBeenCalledWith(expect.objectContaining({ name: 'synth' }));
    rerender(
      <SynthSection
        synth={{ ...synth, plugin: { ...synth.plugin, name: 'synth' } }} onSourceTypeChange={noop} onS3Change={noop} onGithubChange={noop}
        onCodestarChange={noop} onCodecommitChange={noop} onPluginChange={onPlugin} onMetadataChange={onMeta} onNetworkTypeChange={noop} onNetworkChange={noop} disabled
      />,
    );
    expect(screen.getAllByText('configured').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Plugin Name *')).toBeDisabled();
  });

  it('StagesSection edits alias, adds/removes steps and stages, and shows the empty-stage error', () => {
    const calls: unknown[][] = [];
    const rec = (name: string) => (...a: unknown[]) => calls.push([name, ...a]);
    const stage = { ...createEmptyStage(), stageName: 'Build', steps: [] as FormStep[] };
    render(
      <StagesSection
        stages={[stage]} onAddStage={rec('addStage')} onRemoveStage={rec('removeStage')} onStageFieldChange={rec('field')}
        onAddStep={rec('addStep')} onRemoveStep={rec('removeStep')} onStepChange={rec('step')}
        errors={{ 'stages.0.steps': 'Stage must have at least one step' }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Stage must have at least one step');
    change(screen.getByLabelText('Alias'), 'b');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Step' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add Stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Stage' }));
    // (`+ Add Stage` hands its click event through; only the name matters there.)
    expect(calls.map((c) => (c[0] === 'addStage' ? ['addStage'] : c))).toEqual([['field', 0, 'alias', 'b'], ['addStep', 0], ['addStage'], ['removeStage', 0]]);
    expect(screen.getByText('Pipeline Stages (1)')).toBeInTheDocument();
  });

  it('StepEditor: build commands with position, step metadata and step network', () => {
    const onValue = jest.fn<AnyFn>();
    render(
      <Harness
        initial={createEmptyStep()}
        onValue={onValue}
        make={(s, set) => <StepEditor step={s} onChange={set} errorPrefix="stages.0.steps.0" errors={{ 'stages.0.steps.0.plugin.name': 'Plugin name is required' }} />}
      />,
    );
    expect(screen.getByText('Plugin name is required')).toBeInTheDocument();
    const build = screen.getByText('Build commands').closest('details') as HTMLElement;
    fireEvent.click(within(build).getByRole('button', { name: '+ Add Command' }));
    change(within(build).getByPlaceholderText("echo 'starting...'"), 'make');
    change(within(build).getByLabelText('Position'), 'post');
    const net = screen.getByText('Step network').closest('details') as HTMLElement;
    change(within(net).getByLabelText('Network type'), 'subnetIds');
    change(within(net).getByLabelText('VPC ID *'), 'vpc-s');
    const meta = screen.getByText('Step metadata').closest('details') as HTMLElement;
    expect(within(meta).getAllByRole('button').length).toBeGreaterThan(0);
    // An additional input added and removed again.
    fireEvent.click(screen.getByRole('button', { name: '+ Add Additional Input' }));
    fireEvent.click(within(screen.getByText('Additional input artifacts').parentElement as HTMLElement).getByRole('button', { name: 'Remove' }));
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({
      buildCommands: { position: 'post', commands: ['make'] },
      networkType: 'subnetIds', network: expect.objectContaining({ vpcId: 'vpc-s' }),
      additionalInputArtifacts: [],
    }));
  });
});

describe('DefaultsSection / PipelineConfigSection', () => {
  it('defaults stay collapsed to the toggle until enabled', () => {
    const onEnabled = jest.fn<AnyFn>();
    const noop = jest.fn<AnyFn>();
    render(
      <DefaultsSection
        defaults={createInitialFormState().defaults} onEnabledChange={onEnabled} onNetworkTypeChange={noop}
        onNetworkChange={noop} onSGTypeChange={noop} onSGChange={noop} onMetadataChange={noop}
      />,
    );
    expect(screen.queryByLabelText('KMS Key ARN (optional)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Configure pipeline-level CodeBuild defaults'));
    expect(onEnabled).toHaveBeenCalledWith(true);
  });

  it('enabled defaults with metadata read back their values and clear a cleared field', () => {
    const onMeta = jest.fn<AnyFn>();
    const noop = jest.fn<AnyFn>();
    const defaults = {
      ...createInitialFormState().defaults,
      enabled: true,
      metadata: [
        { key: 'aws:cdk:encryption:kmskeyarn', value: 'arn:kms', type: 'string' as const },
        { key: 'aws:cdk:operations:metrics', value: 'true', type: 'boolean' as const },
      ],
    };
    render(
      <DefaultsSection
        defaults={defaults} onEnabledChange={noop} onNetworkTypeChange={noop} onNetworkChange={noop}
        onSGTypeChange={noop} onSGChange={noop} onMetadataChange={onMeta}
      />,
    );
    expect(screen.getByLabelText('KMS Key ARN (optional)')).toHaveValue('arn:kms');
    expect(screen.getByLabelText('Enable CloudWatch failure alarms')).toBeChecked();
    change(screen.getByLabelText('KMS Key ARN (optional)'), '');
    expect(onMeta).toHaveBeenLastCalledWith([{ key: 'aws:cdk:operations:metrics', value: 'true', type: 'boolean' }]);
  });

  it('PipelineConfigSection hides description/keywords without handlers and shows the derived name', () => {
    const noop = jest.fn<AnyFn>();
    render(
      <PipelineConfigSection
        project="web" organization="acme" pipelineName="" onProjectChange={noop} onOrganizationChange={noop} onPipelineNameChange={noop}
      />,
    );
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Keywords (comma-separated)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Pipeline name')).toHaveAttribute('placeholder', 'acme-web-pipeline');
  });
});
