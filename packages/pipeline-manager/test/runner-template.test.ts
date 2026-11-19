// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner stack's IAM, EXACTLY: tag:GetResources (which AWS cannot scope),
 * the four CodePipeline actions on one ARN per allowlisted (region, prefix) and
 * nothing wider unless the operator chose '*', and logs through the basic
 * execution role — no secret, no schedule (push-only: the runner holds no
 * platform credential). Plus both entry points and the CLI's parameter set.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from '@jest/globals';

const { buildRunnerTemplate, pipelineActionResources, runnerStackParameters, RUNNER_PIPELINE_ACTIONS, runnerStackName, runnerFunctionName } =
  await import('../src/utils/runner-template.js');

type Json = any;
const rawBase = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'templates', 'runner-stack.json'), 'utf-8');
const base = (): Json => JSON.parse(rawBase);

const role = (tpl: Json) => tpl.Resources.RunnerRole.Properties;
const policyStatements = (tpl: Json): Json[] => role(tpl).Policies[0].PolicyDocument.Statement;

const ACTIONS = [
  'codepipeline:StartPipelineExecution',
  'codepipeline:StopPipelineExecution',
  'codepipeline:GetPipelineExecution',
  'codepipeline:ListTagsForResource',
];

describe('runner-stack.json', () => {
  it('RunnerId has no default: a stack is always bound to the runner it was registered as', () => {
    expect(base().Parameters.RunnerId.Default).toBeUndefined();
    expect(base().Parameters.RunnerId.MinLength).toBe(1);
  });

  it('has no hard-coded partition', () => {
    expect(rawBase).not.toMatch(/arn:aws:/);
  });

  it('runs on nodejs26.x, 30 s timeout, reserved concurrency 2, and the push-only environment', () => {
    const fn = base().Resources.RunnerFunction.Properties;
    expect(fn.Runtime).toBe('nodejs26.x');
    expect(fn.ReservedConcurrentExecutions).toBe(2);
    expect(fn.Timeout).toBe(30);
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual([
      'ALLOWED_PIPELINE_PREFIXES', 'ALLOWED_REGIONS', 'NODE_ENV', 'PLATFORM_BASE_URL', 'RUNNER_ID', 'RUNNER_VERSION',
    ]);
  });

  it('reports a semver version even when deployed by hand (default 0.0.0 = outdated)', () => {
    expect(base().Parameters.PipelineManagerVersion.Default).toBe('0.0.0');
    expect(base().Resources.RunnerFunction.Properties.Environment.Variables.RUNNER_VERSION).toEqual({ Ref: 'PipelineManagerVersion' });
  });

  it('has no poll machinery: no schedule, no secret, no mode', () => {
    const tpl = base();
    const types = Object.values<Json>(tpl.Resources).map((r) => r.Type);
    expect(types).not.toContain('AWS::Events::Rule');
    expect(rawBase).not.toMatch(/secretsmanager|KeySecretName|ScheduleExpression|"Mode"/);
    expect(Object.keys(tpl.Parameters)).not.toContain('Mode');
  });

  it('Function URL entry point: AuthType NONE and the public invoke permissions', () => {
    const r = base().Resources;
    expect(r.FunctionUrl).toMatchObject({ Type: 'AWS::Lambda::Url', Condition: 'UseFunctionUrl', Properties: { AuthType: 'NONE' } });
    expect(r.FunctionUrlPermission.Properties).toMatchObject({ Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' });
    expect(r.FunctionUrlInvokePermission.Properties).toMatchObject({ Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true });
  });

  it('API Gateway entry point: a regional REST API whose resource policy admits only AllowedIps, and no Function URL', () => {
    const tpl = base();
    const api = tpl.Resources.RunnerApi;
    expect(api.Condition).toBe('UseApiGateway');
    expect(api.Properties.Policy.Statement).toEqual([{
      Effect: 'Allow',
      Principal: '*',
      Action: 'execute-api:Invoke',
      Resource: 'execute-api:/*',
      Condition: { IpAddress: { 'aws:SourceIp': { Ref: 'AllowedIps' } } },
    }]);
    expect(tpl.Conditions).toEqual({
      UseFunctionUrl: { 'Fn::Equals': [{ Ref: 'EntryPoint' }, 'function-url'] },
      UseApiGateway: { 'Fn::Equals': [{ Ref: 'EntryPoint' }, 'api-gateway'] },
    });
    // Every Function URL resource is gated on the Function URL entry point.
    for (const k of ['FunctionUrl', 'FunctionUrlPermission', 'FunctionUrlInvokePermission']) expect(tpl.Resources[k].Condition).toBe('UseFunctionUrl');
    expect(tpl.Outputs.EndpointUrl.Value['Fn::If'][0]).toBe('UseFunctionUrl');
  });
});

describe('buildRunnerTemplate IAM', () => {
  it('exactly tag:GetResources + the four actions the handler calls on each region x prefix, nothing else', () => {
    const tpl = buildRunnerTemplate({ regions: ['us-east-1', 'eu-west-2'], prefixes: ['acme-', 'ops-'] });
    expect(role(tpl).ManagedPolicyArns).toEqual([{ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' }]);
    expect(role(tpl).Policies).toHaveLength(1);
    expect(policyStatements(tpl)).toEqual([
      { Sid: 'FindPipelineByTag', Effect: 'Allow', Action: ['tag:GetResources'], Resource: '*' },
      {
        Sid: 'PipelineActions',
        Effect: 'Allow',
        Action: ACTIONS,
        Resource: [
          { 'Fn::Sub': 'arn:${AWS::Partition}:codepipeline:us-east-1:${AWS::AccountId}:acme-*' },
          { 'Fn::Sub': 'arn:${AWS::Partition}:codepipeline:us-east-1:${AWS::AccountId}:ops-*' },
          { 'Fn::Sub': 'arn:${AWS::Partition}:codepipeline:eu-west-2:${AWS::AccountId}:acme-*' },
          { 'Fn::Sub': 'arn:${AWS::Partition}:codepipeline:eu-west-2:${AWS::AccountId}:ops-*' },
        ],
      },
    ]);
  });

  it('no wildcard beyond the prefix: every pipeline ARN ends in <prefix>*, no wildcard action', () => {
    const tpl = buildRunnerTemplate({ regions: ['us-west-2'], prefixes: ['team_a-'] });
    for (const r of policyStatements(tpl)[1].Resource) expect(r['Fn::Sub']).toMatch(/:team_a-\*$/);
    for (const s of policyStatements(tpl)) for (const a of s.Action) expect(a).not.toMatch(/(^\*$|:\*$)/);
  });

  it("'*' widens to the region's every pipeline (one ARN per region)", () => {
    expect(pipelineActionResources(['us-east-1', 'eu-west-1'], ['*', 'acme-'])).toEqual([
      { 'Fn::Sub': 'arn:${AWS::Partition}:codepipeline:us-east-1:${AWS::AccountId}:*' },
      { 'Fn::Sub': 'arn:${AWS::Partition}:codepipeline:eu-west-1:${AWS::AccountId}:*' },
    ]);
  });

  it('refuses an empty region or prefix list', () => {
    expect(() => pipelineActionResources([], ['a-'])).toThrow(/region/);
    expect(() => pipelineActionResources(['us-east-1'], [])).toThrow(/prefix/);
  });

  it('grants exactly the CodePipeline actions the handler sends (no GetPipelineState)', () => {
    const handlerSrc = ['runner-handler.ts', 'pipeline-tag.ts']
      .map((f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lambda', f), 'utf-8')).join('\n');
    const used = [...new Set([...handlerSrc.matchAll(/new (\w+)Command\(/g)].map((m) => m[1]!))]
      .filter((n) => n !== 'GetResources').map((n) => `codepipeline:${n}`).sort();
    expect([...RUNNER_PIPELINE_ACTIONS].sort()).toEqual(used);
  });

  it('API Gateway: the deployment logical id is keyed to the IP allowlist (a resource policy change only applies once redeployed)', () => {
    const ids = (allowIps: string[]) => {
      const tpl = buildRunnerTemplate({ regions: ['us-east-1'], prefixes: ['a-'], apiGateway: true, allowIps });
      const dep = Object.keys(tpl.Resources).filter((k) => tpl.Resources[k].Type === 'AWS::ApiGateway::Deployment');
      expect(dep).toHaveLength(1);
      expect(tpl.Resources.RunnerApiStage.Properties.DeploymentId).toEqual({ Ref: dep[0] });
      expect(tpl.Resources[dep[0]!].Condition).toBe('UseApiGateway');
      return dep[0];
    };
    expect(ids(['203.0.113.1/32'])).not.toBe(ids(['203.0.113.2/32']));
    expect(ids(['203.0.113.1/32', '198.51.100.0/24'])).toBe(ids(['198.51.100.0/24', '203.0.113.1/32']));
  });

  it('does not mutate the base template', () => {
    const b = base();
    buildRunnerTemplate({ regions: ['us-east-1'], prefixes: ['x-'] }, b);
    expect(b).toEqual(base());
    expect(RUNNER_PIPELINE_ACTIONS).toEqual(ACTIONS);
  });
});

describe('runnerStackParameters', () => {
  it('API Gateway entry point', () => {
    expect(runnerStackParameters({
      regions: ['us-east-1', 'eu-west-2'],
      prefixes: ['acme-'],
      apiGateway: true,
      allowIps: ['203.0.113.0/24', '198.51.100.7/32'],
      runnerId: 'r-1',
      platformBaseUrl: 'https://p.example',
      label: 'ops',
      version: '1.2.3',
    })).toEqual([
      'RunnerId=r-1', 'PlatformBaseUrl=https://p.example', 'EntryPoint=api-gateway', 'AllowedRegions=us-east-1,eu-west-2',
      'AllowedPipelinePrefixes=acme-', 'PipelinePrefix=acme-', 'NameSuffix=-ops', 'PipelineManagerVersion=1.2.3',
      'AllowedIps=203.0.113.0/24,198.51.100.7/32',
    ]);
  });

  it('Function URL, all pipelines', () => {
    const p = runnerStackParameters({ regions: ['us-east-1'], prefixes: ['*'], runnerId: 'r-2', platformBaseUrl: 'https://p', label: 'default', version: 'v' });
    expect(p).toContain('RunnerId=r-2');
    expect(p).toContain('EntryPoint=function-url');
    expect(p).toContain('AllowedPipelinePrefixes=*');
    expect(p.some((x) => x.startsWith('AllowedIps='))).toBe(false);
  });

  it('every parameter it passes exists in the template', () => {
    const declared = Object.keys(base().Parameters);
    const passed = runnerStackParameters({
      regions: ['us-east-1'], prefixes: ['a-'], apiGateway: true, allowIps: ['1.2.3.4/32'], runnerId: 'r', platformBaseUrl: 'https://p', label: 'l', version: 'v',
    }).map((kv) => kv.split('=')[0]);
    for (const k of passed) expect(declared).toContain(k);
  });

  it('names', () => {
    expect(runnerStackName('ops')).toBe('pipeline-builder-runner-ops');
    expect(runnerFunctionName('ops')).toBe('pipeline-builder-runner-ops');
  });
});
