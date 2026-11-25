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

const {
  buildRunnerTemplate, CDK_BOOTSTRAP_ROLE_KINDS, DEFAULT_CDK_QUALIFIER, DEFAULT_WAF_RATE_LIMIT, pipelineActionResources, runnerStackParameters,
  RUNNER_DEPLOY_BUILD_ACTIONS, RUNNER_PIPELINE_ACTIONS, runnerStackName, runnerFunctionName, DEPLOY_RESULT_FILE,
} = await import('../src/utils/runner-template.js');
const {
  DEPLOY_BUILD_QUEUED_TIMEOUT_MINUTES, DEPLOY_BUILD_TIMEOUT_MINUTES, DEPLOY_JOB_EXPORTED_VARIABLES, DEPLOY_JOB_OVERRIDE_ENV,
  deployGrantEncryptionContext, deployLogGroupName, deployProjectName,
} = await import('@pipeline-builder/api-core/pipeline-runners');
const YAML = await import('yaml');

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
      'ALLOWED_PIPELINE_PREFIXES', 'ALLOWED_REGIONS', 'DEPLOY_ENABLED', 'DEPLOY_GRANT_KEY_ARN', 'DEPLOY_PROJECT_NAME', 'NODE_ENV', 'PLATFORM_BASE_URL',
      'REGISTRY_CREDENTIAL_SECRET', 'REGISTRY_PULL_HOST', 'RUNNER_ID', 'RUNNER_VERSION',
    ]);
  });

  it('reports a semver version even when deployed by hand (default 0.0.0 = outdated)', () => {
    expect(base().Parameters.PipelineManagerVersion.Default).toBe('0.0.0');
    expect(base().Resources.RunnerFunction.Properties.Environment.Variables.RUNNER_VERSION).toEqual({ Ref: 'PipelineManagerVersion' });
  });

  it('has no poll machinery: no schedule, no secret for the runner, no mode', () => {
    const tpl = base();
    const types = Object.values<Json>(tpl.Resources).map((r) => r.Type);
    expect(types).not.toContain('AWS::Events::Rule');
    // The runner itself holds no secret: only the deploy job's role reads one (the registry pull credential).
    expect(JSON.stringify(tpl.Resources.RunnerRole)).not.toMatch(/secretsmanager/);
    expect(JSON.stringify(tpl.Resources.RunnerFunction)).not.toMatch(/KeySecretName|"Mode"/);
    expect(rawBase).not.toMatch(/KeySecretName|ScheduleExpression|"Mode"/);
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
    expect(tpl.Conditions).toMatchObject({
      UseFunctionUrl: { 'Fn::Equals': [{ Ref: 'EntryPoint' }, 'function-url'] },
      UseApiGateway: { 'Fn::Equals': [{ Ref: 'EntryPoint' }, 'api-gateway'] },
      UseWaf: { 'Fn::And': [{ Condition: 'UseApiGateway' }, { 'Fn::Equals': [{ Ref: 'EnableWaf' }, 'true'] }] },
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
    expect(policyStatements(tpl).slice(0, 2)).toEqual([
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
    for (const s of policyStatements(tpl).slice(0, 2)) for (const a of s.Action) expect(a).not.toMatch(/(^\*$|:\*$)/);
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

describe('API Gateway WAF rate limit', () => {
  it('a REGIONAL WebACL with one IP rate-based rule, associated with the runner stage, only on the API Gateway entry point', () => {
    const tpl = base();
    expect(tpl.Conditions.UseWaf).toEqual({ 'Fn::And': [{ Condition: 'UseApiGateway' }, { 'Fn::Equals': [{ Ref: 'EnableWaf' }, 'true'] }] });
    const acl = tpl.Resources.RunnerWebAcl;
    expect(acl).toMatchObject({ Type: 'AWS::WAFv2::WebACL', Condition: 'UseWaf', Properties: { Scope: 'REGIONAL', DefaultAction: { Allow: {} } } });
    expect(acl.Properties.Rules).toHaveLength(1);
    expect(acl.Properties.Rules[0]).toMatchObject({
      Action: { Block: {} },
      Statement: { RateBasedStatement: { Limit: { Ref: 'WafRateLimit' }, AggregateKeyType: 'IP' } },
      VisibilityConfig: { CloudWatchMetricsEnabled: true, SampledRequestsEnabled: true },
    });
    const assoc = tpl.Resources.RunnerWebAclAssociation;
    expect(assoc).toMatchObject({ Type: 'AWS::WAFv2::WebACLAssociation', Condition: 'UseWaf' });
    expect(assoc.Properties.WebACLArn).toEqual({ 'Fn::GetAtt': ['RunnerWebAcl', 'Arn'] });
    expect(assoc.Properties.ResourceArn).toEqual({ 'Fn::Sub': 'arn:${AWS::Partition}:apigateway:${AWS::Region}::/restapis/${RunnerApi}/stages/${RunnerApiStage}' });
  });

  it('the rate limit is a parameter with a default inside the WAFv2 bounds, and WAF is on by default', () => {
    const p = base().Parameters;
    expect(p.WafRateLimit).toMatchObject({ Type: 'Number', Default: 1000, MinValue: 10, MaxValue: 2000000000 });
    expect(p.EnableWaf).toMatchObject({ Type: 'String', Default: 'true', AllowedValues: ['true', 'false'] });
    expect(DEFAULT_WAF_RATE_LIMIT).toBe(p.WafRateLimit.Default);
  });

  it('the Function URL entry point is unchanged: no WAF resource can exist without the API', () => {
    const tpl = base();
    const waf = Object.entries<Json>(tpl.Resources).filter(([, r]) => String(r.Type).startsWith('AWS::WAFv2::'));
    expect(waf.map(([k]) => k).sort()).toEqual(['RunnerWebAcl', 'RunnerWebAclAssociation']);
    for (const [, r] of waf) expect(r.Condition).toBe('UseWaf');
    expect(tpl.Resources.FunctionUrl.Properties).toEqual({ AuthType: 'NONE', TargetFunctionArn: { 'Fn::GetAtt': ['RunnerFunction', 'Arn'] } });
  });

  it('buildRunnerTemplate keeps the WAF (and the association still points at the stage once the deployment is re-keyed)', () => {
    const tpl = buildRunnerTemplate({ regions: ['us-east-1'], prefixes: ['a-'], apiGateway: true, allowIps: ['203.0.113.1/32'] });
    expect(tpl.Resources.RunnerWebAcl).toBeDefined();
    expect(tpl.Resources.RunnerWebAclAssociation.Properties.ResourceArn['Fn::Sub']).toContain('${RunnerApiStage}');
  });
});

describe('runnerStackParameters', () => {
  it('API Gateway: WAF on with the given rate limit, or off with waf: false', () => {
    const common = { regions: ['us-east-1'], prefixes: ['a-'], apiGateway: true, allowIps: ['1.2.3.4/32'], runnerId: 'r', platformBaseUrl: 'https://p', version: 'v' };
    const on = runnerStackParameters({ ...common, wafRateLimit: 500 });
    expect(on).toContain('EnableWaf=true');
    expect(on).toContain('WafRateLimit=500');
    // `aws cloudformation deploy` keeps an EXISTING stack's value for an omitted
    // parameter, so the default must be sent explicitly or a stack once deployed
    // with --waf-rate-limit 50 would silently keep 50 after a plain re-run.
    const dflt = runnerStackParameters(common);
    expect(dflt).toContain('EnableWaf=true');
    expect(dflt).toContain(`WafRateLimit=${DEFAULT_WAF_RATE_LIMIT}`);
    const off = runnerStackParameters({ ...common, waf: false, wafRateLimit: 500 });
    expect(off).toContain('EnableWaf=false');
    expect(off.some((x) => x.startsWith('WafRateLimit='))).toBe(false);
  });

  it('Function URL: no WAF parameter at all', () => {
    const p = runnerStackParameters({ regions: ['us-east-1'], prefixes: ['a-'], runnerId: 'r', platformBaseUrl: 'https://p', version: 'v', wafRateLimit: 500 });
    expect(p.some((x) => /^(EnableWaf|WafRateLimit)=/.test(x))).toBe(false);
  });

  it('API Gateway entry point', () => {
    expect(runnerStackParameters({
      regions: ['us-east-1', 'eu-west-2'],
      prefixes: ['acme-'],
      apiGateway: true,
      allowIps: ['203.0.113.0/24', '198.51.100.7/32'],
      runnerId: 'r-1',
      platformBaseUrl: 'https://p.example',
      version: '1.2.3',
    })).toEqual([
      'RunnerId=r-1', 'PlatformBaseUrl=https://p.example', 'EntryPoint=api-gateway', 'AllowedRegions=us-east-1,eu-west-2',
      'AllowedPipelinePrefixes=acme-', 'PipelinePrefix=acme-', 'NameSuffix=-r-1', 'PipelineManagerVersion=1.2.3',
      'AllowedIps=203.0.113.0/24,198.51.100.7/32', 'EnableWaf=true', 'WafRateLimit=1000', 'EnableDeploy=false',
    ]);
  });

  it('Function URL, all pipelines', () => {
    const p = runnerStackParameters({ regions: ['us-east-1'], prefixes: ['*'], runnerId: 'r-2', platformBaseUrl: 'https://p', version: 'v' });
    expect(p).toContain('RunnerId=r-2');
    expect(p).toContain('EntryPoint=function-url');
    expect(p).toContain('AllowedPipelinePrefixes=*');
    expect(p.some((x) => x.startsWith('AllowedIps='))).toBe(false);
  });

  it('every parameter it passes exists in the template', () => {
    const declared = Object.keys(base().Parameters);
    const passed = runnerStackParameters({
      regions: ['us-east-1'], prefixes: ['a-'], apiGateway: true, allowIps: ['1.2.3.4/32'], runnerId: 'r', platformBaseUrl: 'https://p', version: 'v', wafRateLimit: 200,
    }).map((kv) => kv.split('=')[0]);
    for (const k of passed) expect(declared).toContain(k);
  });

  it('names: stack, function and NameSuffix carry the runner id (never the label), within the AWS name limits', () => {
    const id = '3f2b8c1e-9d4a-4e6f-8a7b-1c2d3e4f5a6b';
    expect(runnerStackName(id)).toBe(`pipeline-builder-runner-${id}`);
    expect(runnerFunctionName(id)).toBe(`pipeline-builder-runner-${id}`);
    // Lambda function and IAM role names are at most 64 characters.
    expect(runnerFunctionName(id).length).toBeLessThanOrEqual(64);
    expect(runnerStackParameters({ regions: ['us-east-1'], prefixes: ['a-'], runnerId: id, platformBaseUrl: 'https://p', version: 'v' }))
      .toContain(`NameSuffix=-${id}`);
  });
});

// ─── Deploys through the runner (EnableDeploy / UseDeploy) ───────────────────

const DEPLOY_RESOURCES = ['DeployGrantKey', 'DeployLogGroup', 'DeployProject', 'DeployRole'];
const deployTpl = (regions = ['us-east-1', 'eu-west-2']) => buildRunnerTemplate({ regions, prefixes: ['acme-'] });
const deployRole = (tpl: Json) => tpl.Resources.DeployRole.Properties;
const deployStatements = (tpl: Json): Json[] => deployRole(tpl).Policies[0].PolicyDocument.Statement;
const actionsOf = (st: Json): string[] => [].concat(st.Action);
const subs = (st: Json): string[] => [].concat(st.Resource).map((r: Json) => (typeof r === 'string' ? r : r['Fn::Sub'] ?? JSON.stringify(r)));
/** The RunnerRole's statements once the UseDeploy Fn::If is taken (true) or not. */
const runnerStatementsWhen = (tpl: Json, useDeploy: boolean): Json[] => policyStatements(tpl).flatMap((st) => {
  if (!st['Fn::If']) return [st];
  expect(st['Fn::If'][0]).toBe('UseDeploy');
  const taken = useDeploy ? st['Fn::If'][1] : st['Fn::If'][2];
  return taken?.Ref === 'AWS::NoValue' ? [] : [taken];
});

describe('runner-stack.json: deploys (opt-in)', () => {
  it('EnableDeploy is off by default and gates every deploy resource (condition UseDeploy)', () => {
    const tpl = base();
    expect(tpl.Parameters.EnableDeploy).toMatchObject({ Type: 'String', Default: 'false', AllowedValues: ['true', 'false'] });
    expect(tpl.Conditions.UseDeploy).toEqual({ 'Fn::Equals': [{ Ref: 'EnableDeploy' }, 'true'] });
    for (const k of DEPLOY_RESOURCES) expect(tpl.Resources[k].Condition).toBe('UseDeploy');
    const types = Object.fromEntries(DEPLOY_RESOURCES.map((k) => [k, tpl.Resources[k].Type]));
    expect(types).toEqual({
      DeployGrantKey: 'AWS::KMS::Key', DeployLogGroup: 'AWS::Logs::LogGroup', DeployProject: 'AWS::CodeBuild::Project', DeployRole: 'AWS::IAM::Role',
    });
  });

  it('declares the deploy parameters with their defaults and bounds (the api-core contract)', () => {
    const p = base().Parameters;
    expect(p.RegistryPullHost).toMatchObject({ Type: 'String', Default: '' });
    expect(p.RegistryCredentialSecretName).toMatchObject({ Type: 'String', Default: '' });
    expect(p.CdkQualifier).toMatchObject({ Type: 'String', Default: DEFAULT_CDK_QUALIFIER });
    expect(DEFAULT_CDK_QUALIFIER).toBe('hnb659fds');
    expect(p.DeployTimeoutMinutes).toMatchObject({
      Type: 'Number', Default: DEPLOY_BUILD_TIMEOUT_MINUTES.default, MinValue: DEPLOY_BUILD_TIMEOUT_MINUTES.min, MaxValue: DEPLOY_BUILD_TIMEOUT_MINUTES.max,
    });
    expect(p.DeployConcurrency).toMatchObject({ Type: 'Number', Default: 2, MinValue: 1 });
    expect(p.DeployPermissionsBoundaryArn).toMatchObject({ Type: 'String', Default: '' });
  });

  it('the deploy project: named for the runner, no source / artifacts, not privileged, an inline buildspec running deploy-job', () => {
    const tpl = base();
    const pr = tpl.Resources.DeployProject.Properties;
    expect(pr.Name).toEqual({ 'Fn::Sub': deployProjectName('${RunnerId}') });
    expect(pr.Source.Type).toBe('NO_SOURCE');
    expect(pr.Artifacts).toEqual({ Type: 'NO_ARTIFACTS' });
    expect(pr.ServiceRole).toEqual({ 'Fn::GetAtt': ['DeployRole', 'Arn'] });
    expect(pr.QueuedTimeoutInMinutes).toBe(DEPLOY_BUILD_QUEUED_TIMEOUT_MINUTES);
    expect(pr.TimeoutInMinutes).toEqual({ Ref: 'DeployTimeoutMinutes' });
    expect(pr.ConcurrentBuildLimit).toEqual({ Ref: 'DeployConcurrency' });
    expect(pr.Environment.PrivilegedMode).toBe(false);
    expect(pr.Environment.ImagePullCredentialsType).toBe('SERVICE_ROLE');
    expect(pr.Environment.RegistryCredential).toEqual({ Credential: { Ref: 'RegistryCredentialSecretName' }, CredentialProvider: 'SECRETS_MANAGER' });
    const env = Object.fromEntries(pr.Environment.EnvironmentVariables.map((v: Json) => [v.Name, v.Value]));
    expect(env.PLATFORM_BASE_URL).toEqual({ Ref: 'PlatformBaseUrl' });
    expect(env.PB_RUNNER_ID).toEqual({ Ref: 'RunnerId' });
    expect(env.PB_CDK_QUALIFIER).toEqual({ Ref: 'CdkQualifier' });
    // The request's own values arrive only as StartBuild overrides, never as project defaults.
    for (const name of DEPLOY_JOB_OVERRIDE_ENV) expect(Object.keys(env)).not.toContain(name);
    for (const v of pr.Environment.EnvironmentVariables) expect(v.Type ?? 'PLAINTEXT').toBe('PLAINTEXT');
    expect(pr.LogsConfig.CloudWatchLogs).toEqual({ Status: 'ENABLED', GroupName: { 'Fn::Sub': deployLogGroupName('${RunnerId}') } });

    const spec = YAML.parse(pr.Source.BuildSpec) as Json;
    expect(spec.version).toBe(0.2);
    expect(spec.env['exported-variables']).toEqual([...DEPLOY_JOB_EXPORTED_VARIABLES]);
    expect(spec.phases.build.commands).toEqual([`pipeline-manager pipeline deploy-job --result-file ${DEPLOY_RESULT_FILE}`]);
    // post_build reads back only a code / a stage of the fixed vocabularies — never a message.
    expect(spec.phases.post_build.commands).toHaveLength(2);
    for (const c of spec.phases.post_build.commands) expect(c).toMatch(/\[A-Z_\]|\[a-z_\]/);
    expect(Object.keys(spec.phases)).toEqual(['build', 'post_build']);
  });

  it('its log group: the CodeBuild group name, kept 90 days', () => {
    expect(base().Resources.DeployLogGroup.Properties).toEqual({ LogGroupName: { 'Fn::Sub': deployLogGroupName('${RunnerId}') }, RetentionInDays: 90 });
  });

  it('the deploy role: trusted by CodeBuild for THIS project only, an optional permissions boundary, a name within IAM limits', () => {
    const r = deployRole(deployTpl());
    expect(r.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: 'Allow',
      Principal: { Service: 'codebuild.amazonaws.com' },
      Action: 'sts:AssumeRole',
      Condition: {
        StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
        ArnLike: { 'aws:SourceArn': { 'Fn::Sub': `arn:\${AWS::Partition}:codebuild:\${AWS::Region}:\${AWS::AccountId}:project/${deployProjectName('${RunnerId}')}` } },
      },
    }]);
    expect(r.ManagedPolicyArns).toBeUndefined();
    expect(r.PermissionsBoundary).toEqual({ 'Fn::If': ['HasDeployPermissionsBoundary', { Ref: 'DeployPermissionsBoundaryArn' }, { Ref: 'AWS::NoValue' }] });
    expect(base().Conditions.HasDeployPermissionsBoundary).toEqual({
      'Fn::And': [{ Condition: 'UseDeploy' }, { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'DeployPermissionsBoundaryArn' }, ''] }] }],
    });
    // pb-runner-deploy-<uuid> fits IAM's 64 characters.
    expect(r.RoleName).toEqual({ 'Fn::Sub': 'pb-runner-deploy${NameSuffix}' });
    expect(`pb-runner-deploy-${'3f2b8c1e-9d4a-4e6f-8a7b-1c2d3e4f5a6b'}`.length).toBeLessThanOrEqual(64);
  });

  it('deploy role IAM, EXACTLY: assume only the CDK bootstrap roles per allowlisted region, read the bootstrap version, describe pipeline-builder secrets, read the pull credential, write its own logs', () => {
    const tpl = deployTpl();
    const role = (kind: string, region: string) => `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/cdk-\${CdkQualifier}-${kind}-role-\${AWS::AccountId}-${region}`;
    expect(CDK_BOOTSTRAP_ROLE_KINDS).toEqual(['deploy', 'file-publishing', 'image-publishing', 'lookup']);
    expect(deployStatements(tpl)).toEqual([
      {
        Sid: 'AssumeCdkBootstrapRoles',
        Effect: 'Allow',
        Action: ['sts:AssumeRole'],
        Resource: ['us-east-1', 'eu-west-2'].flatMap((r) => CDK_BOOTSTRAP_ROLE_KINDS.map((k) => ({ 'Fn::Sub': role(k, r) }))),
      },
      {
        Sid: 'ReadCdkBootstrapVersion',
        Effect: 'Allow',
        Action: ['ssm:GetParameter'],
        Resource: ['us-east-1', 'eu-west-2'].map((r) => ({ 'Fn::Sub': `arn:\${AWS::Partition}:ssm:${r}:\${AWS::AccountId}:parameter/cdk-bootstrap/\${CdkQualifier}/version` })),
      },
      {
        Sid: 'DescribeAccountSecrets',
        Effect: 'Allow',
        Action: ['secretsmanager:DescribeSecret'],
        Resource: ['us-east-1', 'eu-west-2'].map((r) => ({ 'Fn::Sub': `arn:\${AWS::Partition}:secretsmanager:${r}:\${AWS::AccountId}:secret:pipeline-builder/*` })),
      },
      {
        Sid: 'ReadRegistryPullCredential',
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: [{ 'Fn::Sub': 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${RegistryCredentialSecretName}-??????' }],
      },
      {
        Sid: 'WriteDeployLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [{ 'Fn::Sub': `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:${deployLogGroupName('${RunnerId}')}:*` }],
      },
    ]);
  });

  it('the deploy role never gets iam:*, a CloudFormation write, a wildcard action or a "*" resource', () => {
    for (const regions of [['us-east-1'], ['us-east-1', 'eu-west-2', 'ap-southeast-2']]) {
      const sts = deployStatements(deployTpl(regions));
      for (const st of sts) {
        expect(st.Effect).toBe('Allow');
        for (const a of actionsOf(st)) {
          expect(a).not.toMatch(/^iam:/);
          expect(a).not.toMatch(/^cloudformation:/);
          expect(a).not.toMatch(/\*/);
          expect(a).not.toMatch(/^kms:/);
        }
        for (const r of subs(st)) expect(r).not.toBe('*');
      }
      const assume = sts.find((s) => s.Sid === 'AssumeCdkBootstrapRoles')!;
      expect(subs(assume)).toHaveLength(regions.length * 4);
      for (const r of subs(assume)) {
        expect(r).toMatch(/^arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/cdk-\$\{CdkQualifier\}-(deploy|file-publishing|image-publishing|lookup)-role-\$\{AWS::AccountId\}-([a-z0-9-]+)$/);
        expect(regions).toContain(/-([a-z]{2}-[a-z]+-\d)$/.exec(r)![1]);
      }
      // No other statement can reach a role.
      for (const st of sts.filter((s) => s !== assume)) expect(actionsOf(st)).not.toContain('sts:AssumeRole');
    }
  });

  it('the runner role gets only StartBuild / BatchGetBuilds / StopBuild / ListBuildsForProject on its own deploy project, and only with UseDeploy', () => {
    const tpl = deployTpl();
    expect(runnerStatementsWhen(tpl, false).map((s) => s.Sid)).toEqual(['FindPipelineByTag', 'PipelineActions']);
    const on = runnerStatementsWhen(tpl, true);
    expect(on.map((s) => s.Sid)).toEqual(['FindPipelineByTag', 'PipelineActions', 'DeployBuild']);
    expect(on[2]).toEqual({
      Sid: 'DeployBuild',
      Effect: 'Allow',
      Action: [...RUNNER_DEPLOY_BUILD_ACTIONS],
      Resource: [{ 'Fn::Sub': `arn:\${AWS::Partition}:codebuild:\${AWS::Region}:\${AWS::AccountId}:project/${deployProjectName('${RunnerId}')}` }],
    });
    expect(RUNNER_DEPLOY_BUILD_ACTIONS).toEqual(['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild', 'codebuild:ListBuildsForProject']);
    // The runner never passes a role, never touches IAM, CloudFormation or a secret.
    for (const st of on) for (const a of actionsOf(st)) expect(a).not.toMatch(/^(iam|cloudformation|secretsmanager|kms):/);
  });

  it('the grant key: only the RunnerRole may Encrypt and only the DeployRole may Decrypt, both under the grant encryption context', () => {
    const key = base().Resources.DeployGrantKey.Properties;
    expect(key.EnableKeyRotation).toBe(true);
    expect(key.KeySpec ?? 'SYMMETRIC_DEFAULT').toBe('SYMMETRIC_DEFAULT');
    const sts: Json[] = key.KeyPolicy.Statement;
    const ctx = Object.fromEntries(Object.entries(deployGrantEncryptionContext('X')).map(([k, v]) => [
      `kms:EncryptionContext:${k}`, k === 'runnerId' ? { Ref: 'RunnerId' } : v,
    ]));
    const runner = sts.find((s) => s.Sid === 'RunnerEncryptsGrants')!;
    expect(runner).toEqual({
      Sid: 'RunnerEncryptsGrants',
      Effect: 'Allow',
      Principal: { AWS: { 'Fn::GetAtt': ['RunnerRole', 'Arn'] } },
      Action: 'kms:Encrypt',
      Resource: '*',
      Condition: { StringEquals: ctx },
    });
    const job = sts.find((s) => s.Sid === 'DeployJobDecryptsGrants')!;
    expect(job).toEqual({
      Sid: 'DeployJobDecryptsGrants',
      Effect: 'Allow',
      Principal: { AWS: { 'Fn::GetAtt': ['DeployRole', 'Arn'] } },
      Action: 'kms:Decrypt',
      Resource: '*',
      Condition: { StringEquals: ctx },
    });
    // Nobody else — not the account root, so no IAM policy can grant either — may use the key's data plane or grant it.
    const DATA = /^kms:(Encrypt|Decrypt|ReEncrypt|GenerateDataKey|CreateGrant|\*)/;
    for (const st of sts.filter((s) => s !== runner && s !== job)) {
      for (const a of actionsOf(st)) expect(a).not.toMatch(DATA);
    }
    const admin = sts.find((s) => s.Sid === 'KeyAdministration')!;
    expect(admin.Principal).toEqual({ AWS: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' } });
    expect(actionsOf(admin)).toContain('kms:PutKeyPolicy');
    expect(sts).toHaveLength(3);
  });

  it('the runner Lambda learns the project, pull host, credential and key from the stack only', () => {
    const v = base().Resources.RunnerFunction.Properties.Environment.Variables;
    expect(v.DEPLOY_ENABLED).toEqual({ Ref: 'EnableDeploy' });
    expect(v.DEPLOY_PROJECT_NAME).toEqual({ 'Fn::If': ['UseDeploy', { 'Fn::Sub': deployProjectName('${RunnerId}') }, ''] });
    expect(v.REGISTRY_PULL_HOST).toEqual({ Ref: 'RegistryPullHost' });
    expect(v.REGISTRY_CREDENTIAL_SECRET).toEqual({ Ref: 'RegistryCredentialSecretName' });
    expect(v.DEPLOY_GRANT_KEY_ARN).toEqual({ 'Fn::If': ['UseDeploy', { 'Fn::GetAtt': ['DeployGrantKey', 'Arn'] }, ''] });
  });

  it('the runner sends exactly the CodeBuild and KMS commands its role / the key policy allow', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lambda', 'runner-deploy.ts'), 'utf-8');
    const used = [...new Set([...src.matchAll(/new (\w+)Command\(/g)].map((m) => m[1]!))].sort();
    const codebuild = used.filter((n) => n !== 'Encrypt' && n !== 'GetResources').map((n) => `codebuild:${n}`).sort();
    expect(codebuild).toEqual([...RUNNER_DEPLOY_BUILD_ACTIONS].sort());
    expect(used).toContain('Encrypt');
    expect(used).not.toContain('Decrypt');
  });
});

describe('runnerStackParameters: deploys', () => {
  const common = { regions: ['us-east-1'], prefixes: ['a-'], runnerId: 'r', platformBaseUrl: 'https://p', version: 'v' };

  it('EnableDeploy is always explicit, so a re-run without --enable-deploy turns deploys off', () => {
    const p = runnerStackParameters(common);
    expect(p).toContain('EnableDeploy=false');
    expect(p.some((x) => /^(RegistryPullHost|RegistryCredentialSecretName|DeployTimeoutMinutes)=/.test(x))).toBe(false);
  });

  it('with deploy: every deploy parameter, explicit (an omitted one would keep the stack\'s old value)', () => {
    const p = runnerStackParameters({
      ...common,
      deploy: { registryPullHost: 'registry.example.com', registryCredentialSecretName: 'pipeline-builder/org-1/registry-push' },
    });
    expect(p).toEqual(expect.arrayContaining([
      'EnableDeploy=true', 'RegistryPullHost=registry.example.com', 'RegistryCredentialSecretName=pipeline-builder/org-1/registry-push',
      `CdkQualifier=${DEFAULT_CDK_QUALIFIER}`, `DeployTimeoutMinutes=${DEPLOY_BUILD_TIMEOUT_MINUTES.default}`, 'DeployConcurrency=2', 'DeployPermissionsBoundaryArn=',
    ]));
    const custom = runnerStackParameters({
      ...common,
      deploy: {
        registryPullHost: 'r:8443',
        registryCredentialSecretName: 's',
        cdkQualifier: 'abc123',
        timeoutMinutes: 90,
        concurrency: 3,
        permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/boundary',
      },
    });
    expect(custom).toEqual(expect.arrayContaining([
      'CdkQualifier=abc123', 'DeployTimeoutMinutes=90', 'DeployConcurrency=3', 'DeployPermissionsBoundaryArn=arn:aws:iam::123456789012:policy/boundary',
    ]));
    const declared = Object.keys(base().Parameters);
    for (const k of custom.map((kv) => kv.split('=')[0])) expect(declared).toContain(k);
  });
});
