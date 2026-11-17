// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { App, Fn, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { RoleConfig } from '../src/core/role-types.js';

// Mock Config.get('aws') used by createCodeBuildDefaultRole
jest.unstable_mockModule('../src/config/app-config.js', () => ({
  Config: {
    get: (key: string) => {
      if (key === 'aws') {
        return { logging: { groupName: '/pipeline-builder/builds/default' } };
      }
      return {};
    },
  },
}));

const { UniqueId } = await import('../src/core/id-generator.js');
const { resolveRole } = await import('../src/core/role.js');
type UniqueId = InstanceType<typeof UniqueId>;

/** A scoped subject condition — every OIDC role must carry one. */
const SUB_CONDITION = {
  'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
};

describe('resolveRole', () => {
  let stack: Stack;
  let id: UniqueId;

  beforeEach(() => {
    stack = new Stack(new App(), 'TestStack');
    id = new UniqueId({ organization: 'test-org', project: 'test-project' });
  });

  describe('roleArn', () => {
    it('should resolve an existing role by ARN', () => {
      const config: RoleConfig = {
        type: 'roleArn',
        options: { roleArn: 'arn:aws:iam::123456789012:role/TestRole' },
      };
      const role = resolveRole(stack, id, config);
      expect(role.roleArn).toBe('arn:aws:iam::123456789012:role/TestRole');
    });

    it('should respect mutable option', () => {
      const config: RoleConfig = {
        type: 'roleArn',
        options: {
          roleArn: 'arn:aws:iam::123456789012:role/ImmutableRole',
          mutable: false,
        },
      };
      const role = resolveRole(stack, id, config);
      expect(role.roleArn).toBe('arn:aws:iam::123456789012:role/ImmutableRole');
    });
  });

  describe('roleName', () => {
    it('should resolve an existing role by name', () => {
      const config: RoleConfig = {
        type: 'roleName',
        options: { roleName: 'TestRole' },
      };
      const role = resolveRole(stack, id, config);
      expect(role.roleName).toBe('TestRole');
    });
  });

  describe('codeBuildDefault', () => {
    it('should create a role with CodeBuild service principal', () => {
      const config: RoleConfig = {
        type: 'codeBuildDefault',
        options: {},
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { Service: 'codebuild.amazonaws.com' },
            },
          ],
        },
      });
    });

    it('should attach CloudWatch Logs policy', () => {
      const config: RoleConfig = {
        type: 'codeBuildDefault',
        options: {},
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              Effect: 'Allow',
              // Partition-aware: never a hardcoded `arn:aws`.
              Resource: {
                'Fn::Join': ['', [
                  'arn:', { Ref: 'AWS::Partition' },
                  ':logs:', { Ref: 'AWS::Region' },
                  ':', { Ref: 'AWS::AccountId' },
                  ':log-group:/pipeline-builder/builds/*:*',
                ]],
              },
            },
          ],
        },
      });
    });
  });

  describe('oidc', () => {
    it('should create a role with OIDC provider from issuer', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          conditions: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
                },
              },
            },
          ],
        },
      });
    });

    it('should create a role with OIDC provider from existing ARN', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          providerArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
          conditions: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
                },
              },
            },
          ],
        },
      });
    });

    it('should apply StringEquals conditions to trust policy', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          conditions: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                },
              },
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should apply StringLike conditions for wildcard matching', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          conditionsLike: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/*',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringLike: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/*',
                },
              },
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should set custom role name when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          clientIds: ['sts.amazonaws.com'],
          roleName: 'MyOidcRole',
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'MyOidcRole',
      });
    });

    it('should attach managed policies when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          clientIds: ['sts.amazonaws.com'],
          managedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/ReadOnlyAccess',
        ],
      });
    });

    it('should default clientIds to sts.amazonaws.com when using issuer', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should throw when neither providerArn nor issuer is provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {},
      };
      expect(() => resolveRole(stack, id, config)).toThrow(
        'OIDC role config requires either providerArn or issuer',
      );
    });

    it('should include thumbprints when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should throw when both providerArn and issuer are provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          providerArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
          issuer: 'https://token.actions.githubusercontent.com',
        },
      };
      expect(() => resolveRole(stack, id, config)).toThrow(
        'OIDC role config must specify either providerArn or issuer, not both',
      );
    });

    it('should set description on the role', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          description: 'OIDC role for GitHub Actions CI/CD',
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        Description: 'OIDC role for GitHub Actions CI/CD',
      });
    });

    it('should set maxSessionDuration on the role', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          maxSessionDuration: 7200,
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        MaxSessionDuration: 7200,
      });
    });

    it('should attach permission boundary when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/DeveloperBoundary',
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        PermissionsBoundary: 'arn:aws:iam::123456789012:policy/DeveloperBoundary',
      });
    });

    it('should add inline policy statements', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          policyStatements: [
            {
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: ['arn:aws:s3:::my-bucket', 'arn:aws:s3:::my-bucket/*'],
            },
          ],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: ['s3:GetObject', 's3:ListBucket'],
              Effect: 'Allow',
              Resource: ['arn:aws:s3:::my-bucket', 'arn:aws:s3:::my-bucket/*'],
            },
          ],
        },
      });
    });

    it('should support Deny effect in inline policy statements', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          conditions: SUB_CONDITION,
          policyStatements: [
            {
              effect: 'Deny',
              actions: ['s3:DeleteBucket'],
              resources: ['*'],
            },
          ],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 's3:DeleteBucket',
              Effect: 'Deny',
              Resource: '*',
            },
          ],
        },
      });
    });
  });

  describe('oidc trust scoping (fail closed)', () => {
    const GH = 'https://token.actions.githubusercontent.com';
    const trustCondition = (template: Template): Record<string, Record<string, unknown>> => {
      // Issuer mode also synthesizes the provider custom resource's Lambda role.
      const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
      const role = roles.find((r) => r.Properties.AssumeRolePolicyDocument.Statement[0].Action === 'sts:AssumeRoleWithWebIdentity');
      return role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
    };

    it('REGRESSION: refuses an issuer-only role any GitHub repository could assume', () => {
      const config: RoleConfig = { type: 'oidc', options: { issuer: GH } };
      expect(() => resolveRole(stack, id, config)).toThrow(/token\.actions\.githubusercontent\.com:sub/);
      expect(() => resolveRole(stack, id, config)).toThrow(/repo:acme\/app:ref:refs\/heads\/main/);
    });

    it('refuses an aud-only condition set (aud does not scope the subject)', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: { issuer: GH, conditions: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' } },
      };
      expect(() => resolveRole(stack, id, config)).toThrow(/must restrict the token subject/);
    });

    it('refuses a sub condition keyed to a different issuer host', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: { issuer: GH, conditions: { 'gitlab.com:sub': 'project_path:acme/app:ref_type:branch:ref:main' } },
      };
      expect(() => resolveRole(stack, id, config)).toThrow(/token\.actions\.githubusercontent\.com:sub/);
    });

    it('refuses a bare wildcard sub', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: { issuer: GH, conditionsLike: { 'token.actions.githubusercontent.com:sub': '*' } },
      };
      expect(() => resolveRole(stack, id, config)).toThrow(/bare '\*' wildcard/);
    });

    it('accepts a sub in conditionsLike and auto-pins aud in StringEquals', () => {
      resolveRole(stack, id, {
        type: 'oidc',
        options: { issuer: GH, conditionsLike: { 'token.actions.githubusercontent.com:sub': 'repo:acme/*' } },
      });
      expect(trustCondition(Template.fromStack(stack))).toEqual({
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:acme/*' },
      });
    });

    it('pins aud to the configured clientId when the caller did not set it', () => {
      resolveRole(stack, id, {
        type: 'oidc',
        options: { issuer: GH, clientIds: ['my-audience'], conditions: SUB_CONDITION },
      });
      expect(trustCondition(Template.fromStack(stack)).StringEquals).toEqual({
        ...SUB_CONDITION,
        'token.actions.githubusercontent.com:aud': 'my-audience',
      });
    });

    it('respects an explicit aud (StringEquals or StringLike) instead of overriding it', () => {
      resolveRole(stack, id, {
        type: 'oidc',
        options: {
          issuer: GH,
          conditions: SUB_CONDITION,
          conditionsLike: { 'token.actions.githubusercontent.com:aud': 'custom-*' },
        },
      });
      const cond = trustCondition(Template.fromStack(stack));
      expect(cond.StringEquals).toEqual(SUB_CONDITION);
      expect(cond.StringLike).toEqual({ 'token.actions.githubusercontent.com:aud': 'custom-*' });
    });

    it('derives the condition host from providerArn (oidc-provider/<host>)', () => {
      const arn = 'arn:aws:iam::123456789012:oidc-provider/gitlab.example.com';
      expect(() => resolveRole(stack, id, { type: 'oidc', options: { providerArn: arn, conditions: SUB_CONDITION } }))
        .toThrow(/gitlab\.example\.com:sub/);

      resolveRole(stack, id, {
        type: 'oidc',
        options: { providerArn: arn, conditions: { 'gitlab.example.com:sub': 'project_path:acme/app:ref_type:branch:ref:main' } },
      });
      expect(trustCondition(Template.fromStack(stack)).StringEquals).toEqual({
        'gitlab.example.com:sub': 'project_path:acme/app:ref_type:branch:ref:main',
        'gitlab.example.com:aud': 'sts.amazonaws.com',
      });
    });

    it('takes the aud host from the sub key when providerArn is an unresolved token', () => {
      const providerArn = Fn.importValue('GitHubOidcProviderArn');
      expect(() => resolveRole(stack, id, { type: 'oidc', options: { providerArn } }))
        .toThrow(/must restrict the token subject/);

      resolveRole(stack, id, { type: 'oidc', options: { providerArn, conditions: SUB_CONDITION } });
      expect(trustCondition(Template.fromStack(stack)).StringEquals).toEqual({
        ...SUB_CONDITION,
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      });
    });

    it('pins aud to every configured clientId (any-of) when several are trusted', () => {
      resolveRole(stack, id, {
        type: 'oidc',
        options: { issuer: GH, clientIds: ['aud-a', 'aud-b'], conditions: SUB_CONDITION },
      });
      expect(trustCondition(Template.fromStack(stack)).StringEquals['token.actions.githubusercontent.com:aud'])
        .toEqual(['aud-a', 'aud-b']);
    });

    it('keeps an issuer path (and drops a trailing slash) in the condition host', () => {
      resolveRole(stack, id, {
        type: 'oidc',
        options: {
          issuer: 'https://oidc.example.com/tenant-1/',
          conditions: { 'oidc.example.com/tenant-1:sub': 'system:serviceaccount:ci:deployer' },
        },
      });
      expect(trustCondition(Template.fromStack(stack)).StringEquals).toEqual({
        'oidc.example.com/tenant-1:sub': 'system:serviceaccount:ci:deployer',
        'oidc.example.com/tenant-1:aud': 'sts.amazonaws.com',
      });
    });
  });

  it('should throw for unknown role config type', () => {
    const config = { type: 'unknown', options: {} } as any;
    expect(() => resolveRole(stack, id, config)).toThrow('Unknown role config type');
  });
});
